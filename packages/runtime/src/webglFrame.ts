import type { WebGLMeshVertex } from "./webglMesh.js";

/** Blend modes the whole-frame WebGL path reproduces exactly like Canvas2D composite operations. */
export type FrameBlendMode = "normal" | "multiply" | "screen" | "additive";

export interface FrameMesh {
  image: TexImageSource;
  /** Device-pixel positions (y down) and image UVs (v down). */
  vertices: readonly WebGLMeshVertex[];
  triangles: readonly number[];
  opacity: number;
  mode: FrameBlendMode;
  /** Multiply and screen colors, applied to the straight color before opacity. */
  colors?: { multiply: readonly number[]; screen: readonly number[] };
}

export type FrameStep =
  | { kind: "mesh"; mesh: FrameMesh }
  /** Content drawn on its own layer, kept where the masks are (or, inverted, where they are absent), then laid over the frame. */
  | { kind: "clip"; invert: boolean; masks: readonly FrameMesh[]; content: readonly FrameMesh[] };

interface Box { x0: number; y0: number; x1: number; y1: number }
interface Packed { first: number; count: number; box: Box | undefined }

const CONTEXT_OPTIONS: WebGLContextAttributes = {
  alpha: true,
  premultipliedAlpha: true,
  preserveDrawingBuffer: true,
  antialias: false,
  depth: false,
  stencil: false
};

/**
 * Draws a whole frame in one WebGL2 context: every mesh is a single draw call, and clips use two
 * frame-sized layers limited by a scissor box. The Canvas2D path draws each triangle on its own,
 * which is too slow for models with tens of thousands of triangles. The result matches
 * Canvas2D's source-over, multiply, screen and lighter operations on premultiplied colors.
 */
export class WebGLFrameRenderer {
  readonly canvas: HTMLCanvasElement;
  private readonly gl: WebGL2RenderingContext;
  private disposed = false;
  private statusValue: "ready" | "context-lost" | "restore-failed" = "ready";
  private resources!: ReturnType<WebGLFrameRenderer["createResources"]>;
  private textures = new Map<TexImageSource, WebGLTexture>();
  private layers: { width: number; height: number; mask: { texture: WebGLTexture; framebuffer: WebGLFramebuffer }; content: { texture: WebGLTexture; framebuffer: WebGLFramebuffer } } | undefined;
  private vertexData = new Float32Array(0);
  private indexData = new Uint32Array(0);
  private vertexCapacity = 0;
  private indexCapacity = 0;

  constructor(canvas?: HTMLCanvasElement) {
    this.canvas = canvas ?? document.createElement("canvas");
    const gl = this.canvas.getContext("webgl2", CONTEXT_OPTIONS);
    if (!gl) throw new Error("WebGL2 frame renderer is unavailable");
    this.gl = gl;
    this.resources = this.createResources();
    this.canvas.addEventListener("webglcontextlost", (event) => {
      event.preventDefault();
      this.statusValue = "context-lost";
    });
    this.canvas.addEventListener("webglcontextrestored", () => {
      if (this.disposed) return;
      this.textures.clear();
      this.layers = undefined;
      this.vertexCapacity = 0;
      this.indexCapacity = 0;
      try {
        this.resources = this.createResources();
        this.statusValue = "ready";
      } catch {
        this.statusValue = "restore-failed";
      }
    });
  }

  get status(): "ready" | "context-lost" | "restore-failed" {
    return this.statusValue;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const gl = this.gl;
    for (const texture of this.textures.values()) gl.deleteTexture(texture);
    this.textures.clear();
    this.deleteLayers();
    const { meshProgram, compositeProgram, vertexBuffer, indexBuffer, meshVao, emptyVao } = this.resources;
    gl.deleteBuffer(vertexBuffer);
    gl.deleteBuffer(indexBuffer);
    gl.deleteVertexArray(meshVao);
    gl.deleteVertexArray(emptyVao);
    gl.deleteProgram(meshProgram);
    gl.deleteProgram(compositeProgram);
    this.vertexData = new Float32Array(0);
    this.indexData = new Uint32Array(0);
    // Each model reload makes a new renderer; release the context now rather than at garbage collection.
    (gl.getExtension("WEBGL_lose_context") as { loseContext(): void } | null)?.loseContext();
  }

  /** Draws the steps in order onto a cleared, transparent `width` x `height` surface. Returns false when WebGL cannot draw. */
  render(width: number, height: number, steps: readonly FrameStep[]): boolean {
    const gl = this.gl;
    if (this.disposed || this.statusValue !== "ready" || gl.isContextLost()) return false;
    width = Math.max(1, Math.floor(width));
    height = Math.max(1, Math.floor(height));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    const packed = this.pack(steps, width, height);
    const r = this.resources;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.DEPTH_TEST);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.useProgram(r.meshProgram);
    gl.uniform2f(r.resolution, width, height);
    gl.bindVertexArray(r.meshVao);
    gl.activeTexture(gl.TEXTURE0);
    for (const step of steps) {
      if (step.kind === "mesh") {
        this.drawMesh(step.mesh, packed.get(step.mesh)!);
        continue;
      }
      const contentBox = unionBoxes(step.content.map((mesh) => packed.get(mesh)!.box));
      const box = step.invert ? contentBox : intersectBoxes(contentBox, unionBoxes(step.masks.map((mesh) => packed.get(mesh)!.box)));
      if (!box) continue;
      const layers = this.ensureLayers(width, height);
      gl.enable(gl.SCISSOR_TEST);
      // Positions are y-down; the scissor box is in GL's y-up framebuffer rows.
      gl.scissor(box.x0, height - box.y1, box.x1 - box.x0, box.y1 - box.y0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, layers.mask.framebuffer);
      gl.clear(gl.COLOR_BUFFER_BIT);
      for (const mesh of step.masks) this.drawMesh(mesh, packed.get(mesh)!);
      gl.bindFramebuffer(gl.FRAMEBUFFER, layers.content.framebuffer);
      gl.clear(gl.COLOR_BUFFER_BIT);
      for (const mesh of step.content) this.drawMesh(mesh, packed.get(mesh)!);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.useProgram(r.compositeProgram);
      gl.bindVertexArray(r.emptyVao);
      gl.uniform1i(r.invert, step.invert ? 1 : 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, layers.content.texture);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, layers.mask.texture);
      gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.disable(gl.SCISSOR_TEST);
      gl.useProgram(r.meshProgram);
      gl.bindVertexArray(r.meshVao);
      gl.activeTexture(gl.TEXTURE0);
    }
    gl.bindVertexArray(null);
    return true;
  }

  /** Uploads every mesh once per frame; indices are rebased so each mesh stays one draw call. */
  private pack(steps: readonly FrameStep[], width: number, height: number): Map<FrameMesh, Packed> {
    const meshes: FrameMesh[] = [];
    for (const step of steps) {
      if (step.kind === "mesh") meshes.push(step.mesh);
      else meshes.push(...step.masks, ...step.content);
    }
    let vertexCount = 0, indexCount = 0;
    for (const mesh of meshes) { vertexCount += mesh.vertices.length; indexCount += mesh.triangles.length; }
    if (this.vertexData.length < vertexCount * 4) this.vertexData = new Float32Array(Math.ceil(vertexCount * 4 * 1.25));
    if (this.indexData.length < indexCount) this.indexData = new Uint32Array(Math.ceil(indexCount * 1.25));
    const vertices = this.vertexData, indices = this.indexData, packed = new Map<FrameMesh, Packed>();
    let base = 0, first = 0;
    for (const mesh of meshes) {
      if (packed.has(mesh)) continue;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let index = 0; index < mesh.vertices.length; index += 1) {
        const vertex = mesh.vertices[index], offset = (base + index) * 4;
        vertices[offset] = vertex.x; vertices[offset + 1] = vertex.y; vertices[offset + 2] = vertex.u; vertices[offset + 3] = vertex.v;
        if (vertex.x < x0) x0 = vertex.x; if (vertex.x > x1) x1 = vertex.x;
        if (vertex.y < y0) y0 = vertex.y; if (vertex.y > y1) y1 = vertex.y;
      }
      for (let index = 0; index < mesh.triangles.length; index += 1) indices[first + index] = base + mesh.triangles[index];
      // Linear filtering can reach one pixel past the outermost vertex.
      const box = x1 >= x0 ? clampBox({ x0: Math.floor(x0) - 2, y0: Math.floor(y0) - 2, x1: Math.ceil(x1) + 2, y1: Math.ceil(y1) + 2 }, width, height) : undefined;
      packed.set(mesh, { first, count: mesh.triangles.length, box });
      base += mesh.vertices.length;
      first += mesh.triangles.length;
    }
    const gl = this.gl, r = this.resources;
    gl.bindBuffer(gl.ARRAY_BUFFER, r.vertexBuffer);
    if (this.vertexCapacity < base * 16) {
      this.vertexCapacity = vertices.byteLength;
      gl.bufferData(gl.ARRAY_BUFFER, this.vertexCapacity, gl.STREAM_DRAW);
    }
    if (base) gl.bufferSubData(gl.ARRAY_BUFFER, 0, vertices, 0, base * 4);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, r.indexBuffer);
    if (this.indexCapacity < first * 4) {
      this.indexCapacity = indices.byteLength;
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.indexCapacity, gl.STREAM_DRAW);
    }
    if (first) gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, 0, indices, 0, first);
    return packed;
  }

  private drawMesh(mesh: FrameMesh, packed: Packed) {
    if (!packed.count || !packed.box) return;
    const gl = this.gl, r = this.resources;
    gl.bindTexture(gl.TEXTURE_2D, this.textureFor(mesh.image));
    gl.uniform1f(r.opacity, Math.min(1, Math.max(0, mesh.opacity)));
    if (mesh.colors) {
      gl.uniform1i(r.colored, 1);
      gl.uniform3f(r.multiply, mesh.colors.multiply[0], mesh.colors.multiply[1], mesh.colors.multiply[2]);
      gl.uniform3f(r.screen, mesh.colors.screen[0], mesh.colors.screen[1], mesh.colors.screen[2]);
    } else {
      gl.uniform1i(r.colored, 0);
    }
    const draw = () => gl.drawElements(gl.TRIANGLES, packed.count, gl.UNSIGNED_INT, packed.first * 4);
    switch (mesh.mode) {
      case "additive":
        // Canvas "lighter": both color and alpha add, clamped.
        gl.uniform1i(r.pass, 0);
        gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ONE, gl.ONE);
        draw();
        break;
      case "screen":
        // s + d - s*d, which is the separable screen blend on premultiplied colors.
        gl.uniform1i(r.pass, 0);
        gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_COLOR, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        draw();
        break;
      case "multiply":
        // s*(1-da) + d*(s + 1 - sa) without dual-source blending: first scale the
        // destination by (s + 1 - sa), then add s*(1-da) with the untouched alpha.
        gl.uniform1i(r.pass, 1);
        gl.blendFuncSeparate(gl.ZERO, gl.SRC_COLOR, gl.ZERO, gl.ONE);
        draw();
        gl.uniform1i(r.pass, 0);
        gl.blendFuncSeparate(gl.ONE_MINUS_DST_ALPHA, gl.ONE, gl.ONE_MINUS_DST_ALPHA, gl.ONE);
        draw();
        break;
      default:
        gl.uniform1i(r.pass, 0);
        gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        draw();
    }
  }

  private textureFor(image: TexImageSource): WebGLTexture {
    const existing = this.textures.get(image);
    if (existing) return existing;
    const gl = this.gl;
    const texture = gl.createTexture();
    if (!texture) throw new Error("Could not create a WebGL2 frame texture");
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    this.textures.set(image, texture);
    return texture;
  }

  private ensureLayers(width: number, height: number) {
    if (this.layers && this.layers.width === width && this.layers.height === height) return this.layers;
    this.deleteLayers();
    const gl = this.gl;
    const layer = () => {
      const texture = gl.createTexture(), framebuffer = gl.createFramebuffer();
      if (!texture || !framebuffer) throw new Error("Could not create a WebGL2 clip layer");
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height);
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      return { texture, framebuffer };
    };
    this.layers = { width, height, mask: layer(), content: layer() };
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return this.layers;
  }

  private deleteLayers() {
    if (!this.layers) return;
    for (const layer of [this.layers.mask, this.layers.content]) {
      this.gl.deleteFramebuffer(layer.framebuffer);
      this.gl.deleteTexture(layer.texture);
    }
    this.layers = undefined;
  }

  private createResources() {
    const gl = this.gl;
    const meshProgram = this.link(`#version 300 es
      precision highp float;
      layout(location = 0) in vec2 a_position;
      layout(location = 1) in vec2 a_texCoord;
      uniform vec2 u_resolution;
      out vec2 v_texCoord;
      void main() {
        vec2 clip = a_position / u_resolution * 2.0 - 1.0;
        gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
        v_texCoord = a_texCoord;
      }`, `#version 300 es
      precision highp float;
      uniform sampler2D u_texture;
      uniform float u_opacity;
      uniform bool u_colored;
      uniform vec3 u_multiply;
      uniform vec3 u_screen;
      uniform int u_pass;
      in vec2 v_texCoord;
      out vec4 outColor;
      void main() {
        vec4 color = texture(u_texture, v_texCoord);
        if (u_colored && color.a > 0.0) {
          vec3 straight = color.rgb / color.a * u_multiply;
          color.rgb = (straight + u_screen - straight * u_screen) * color.a;
        }
        color *= u_opacity;
        outColor = u_pass == 1 ? vec4(color.rgb + (1.0 - color.a), 1.0) : color;
      }`);
    const compositeProgram = this.link(`#version 300 es
      void main() {
        vec2 corner = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
        gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
      }`, `#version 300 es
      precision highp float;
      uniform sampler2D u_content;
      uniform sampler2D u_mask;
      uniform bool u_invert;
      out vec4 outColor;
      void main() {
        ivec2 pixel = ivec2(gl_FragCoord.xy);
        float mask = texelFetch(u_mask, pixel, 0).a;
        outColor = texelFetch(u_content, pixel, 0) * (u_invert ? 1.0 - mask : mask);
      }`);
    const vertexBuffer = gl.createBuffer(), indexBuffer = gl.createBuffer();
    const meshVao = gl.createVertexArray(), emptyVao = gl.createVertexArray();
    const uniform = (program: WebGLProgram, name: string) => {
      const location = gl.getUniformLocation(program, name);
      if (!location) throw new Error(`WebGL2 frame renderer is missing uniform ${name}`);
      return location;
    };
    if (!vertexBuffer || !indexBuffer || !meshVao || !emptyVao) throw new Error("Could not create WebGL2 frame buffers");
    gl.bindVertexArray(meshVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bindVertexArray(null);
    const resources = {
      meshProgram, compositeProgram, vertexBuffer, indexBuffer, meshVao, emptyVao,
      resolution: uniform(meshProgram, "u_resolution"),
      opacity: uniform(meshProgram, "u_opacity"),
      colored: uniform(meshProgram, "u_colored"),
      multiply: uniform(meshProgram, "u_multiply"),
      screen: uniform(meshProgram, "u_screen"),
      pass: uniform(meshProgram, "u_pass"),
      invert: uniform(compositeProgram, "u_invert")
    };
    gl.useProgram(meshProgram);
    gl.uniform1i(uniform(meshProgram, "u_texture"), 0);
    gl.useProgram(compositeProgram);
    gl.uniform1i(uniform(compositeProgram, "u_content"), 1);
    gl.uniform1i(uniform(compositeProgram, "u_mask"), 2);
    return resources;
  }

  private link(vertexSource: string, fragmentSource: string): WebGLProgram {
    const gl = this.gl;
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type);
      if (!shader) throw new Error("Could not create a WebGL2 frame shader");
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const message = gl.getShaderInfoLog(shader) || "unknown compile error";
        gl.deleteShader(shader);
        throw new Error(`Could not compile a WebGL2 frame shader: ${message}`);
      }
      return shader;
    };
    const program = gl.createProgram();
    if (!program) throw new Error("Could not create a WebGL2 frame program");
    const vertexShader = compile(gl.VERTEX_SHADER, vertexSource), fragmentShader = compile(gl.FRAGMENT_SHADER, fragmentSource);
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const message = gl.getProgramInfoLog(program) || "unknown link error";
      gl.deleteProgram(program);
      throw new Error(`Could not link a WebGL2 frame program: ${message}`);
    }
    return program;
  }
}

function clampBox(box: Box, width: number, height: number): Box | undefined {
  const clamped = { x0: Math.max(0, box.x0), y0: Math.max(0, box.y0), x1: Math.min(width, box.x1), y1: Math.min(height, box.y1) };
  return clamped.x1 > clamped.x0 && clamped.y1 > clamped.y0 ? clamped : undefined;
}

function unionBoxes(boxes: ReadonlyArray<Box | undefined>): Box | undefined {
  let result: Box | undefined;
  for (const box of boxes) {
    if (!box) continue;
    result = result ? { x0: Math.min(result.x0, box.x0), y0: Math.min(result.y0, box.y0), x1: Math.max(result.x1, box.x1), y1: Math.max(result.y1, box.y1) } : { ...box };
  }
  return result;
}

function intersectBoxes(a: Box | undefined, b: Box | undefined): Box | undefined {
  if (!a || !b) return undefined;
  const box = { x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) };
  return box.x1 > box.x0 && box.y1 > box.y0 ? box : undefined;
}
