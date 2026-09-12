export interface WebGLMeshVertex {
  x: number;
  y: number;
  u: number;
  v: number;
}

export interface PixelParityGate {
  maxDifferingPixelRatio: number;
  maxMeanChannelDelta: number;
}

export interface PixelParityOptions {
  maxDifferingPixelRatio?: number;
  maxMeanChannelDelta?: number;
}

export interface PixelParityResult {
  width: number;
  height: number;
  differingPixels: number;
  differingPixelRatio: number;
  maxChannelDelta: number;
  meanChannelDelta: number;
  gate: PixelParityGate;
  pass: boolean;
}

const CONTEXT_OPTIONS: WebGLContextAttributes = {
  alpha: true,
  premultipliedAlpha: true,
  preserveDrawingBuffer: true,
  antialias: false,
  depth: false,
  stencil: false
};

/**
 * WebGL2 ArtMesh raster path. It renders one part into an offscreen surface
 * and composites that surface into the existing Canvas2D target, preserving
 * the caller's draw order and keeping Canvas2D as the fallback path.
 */
export class WebGLArtMeshRenderer {
  readonly canvas: HTMLCanvasElement;
  private readonly gl: WebGL2RenderingContext;
  private readonly contextLossExtension: { loseContext(): void; restoreContext(): void } | null;
  private program: WebGLProgram;
  private vertexBuffer: WebGLBuffer;
  private indexBuffer: WebGLBuffer;
  private disposed = false;
  private textures = new Set<WebGLTexture>();
  private vertexData = new Float32Array(0);
  private indexData = new Uint32Array(0);
  private vertexCapacity = 0;
  private indexCapacity = 0;
  private textureByImage = new WeakMap<HTMLImageElement, WebGLTexture>();
  private positionLocation: number;
  private texCoordLocation: number;
  private resolutionLocation: WebGLUniformLocation;
  private opacityLocation: WebGLUniformLocation;
  private statusValue: "ready" | "context-lost" | "restore-failed" = "ready";

  constructor(canvas?: HTMLCanvasElement) {
    this.canvas = canvas ?? document.createElement("canvas");
    const gl = this.canvas.getContext("webgl2", CONTEXT_OPTIONS);
    if (!gl) throw new Error("WebGL2 ArtMesh renderer is unavailable");
    this.gl = gl;
    this.contextLossExtension = gl.getExtension("WEBGL_lose_context") as { loseContext(): void; restoreContext(): void } | null;
    const resources = this.createResources();
    this.program = resources.program;
    this.vertexBuffer = resources.vertexBuffer;
    this.indexBuffer = resources.indexBuffer;
    this.positionLocation = resources.positionLocation;
    this.texCoordLocation = resources.texCoordLocation;
    this.resolutionLocation = resources.resolutionLocation;
    this.opacityLocation = resources.opacityLocation;
    this.canvas.addEventListener("webglcontextlost", (event) => {
      event.preventDefault();
      this.statusValue = "context-lost";
    });
    this.canvas.addEventListener("webglcontextrestored", () => {
      if (this.disposed) return;
      this.textures.clear();
      try {
        const restored = this.createResources();
        this.program = restored.program;
        this.vertexBuffer = restored.vertexBuffer;
        this.indexBuffer = restored.indexBuffer;
        this.positionLocation = restored.positionLocation;
        this.texCoordLocation = restored.texCoordLocation;
        this.resolutionLocation = restored.resolutionLocation;
        this.opacityLocation = restored.opacityLocation;
        this.vertexCapacity = 0;
        this.indexCapacity = 0;
        this.textureByImage = new WeakMap<HTMLImageElement, WebGLTexture>();
        this.statusValue = "ready";
      } catch {
        this.statusValue = "restore-failed";
      }
    });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const texture of this.textures) this.gl.deleteTexture(texture);
    this.textures.clear();
    this.gl.deleteBuffer(this.vertexBuffer);
    this.gl.deleteBuffer(this.indexBuffer);
    this.gl.deleteProgram(this.program);
    this.textureByImage = new WeakMap();
    this.vertexData = new Float32Array(0);
    this.indexData = new Uint32Array(0);
    this.contextLossExtension?.loseContext();
  }

  get status(): "ready" | "context-lost" | "restore-failed" {
    return this.statusValue;
  }

  /** Test hook used by browser regression QA; production rendering never calls this automatically. */
  simulateContextLoss(): boolean {
    const extension = this.contextLossExtension;
    if (!extension) return false;
    extension.loseContext();
    return true;
  }

  /** Test hook used by browser regression QA to request context restoration. */
  simulateContextRestore(): boolean {
    const extension = this.contextLossExtension;
    if (!extension) return false;
    extension.restoreContext();
    return true;
  }

  draw(
    target: CanvasRenderingContext2D,
    image: HTMLImageElement,
    vertices: WebGLMeshVertex[],
    triangles: number[],
    opacity: number,
    blendMode: GlobalCompositeOperation = "source-over"
  ): boolean {
    if (this.disposed || this.statusValue !== "ready" || this.gl.isContextLost() || vertices.length < 3 || triangles.length < 3) return false;
    const width = Math.max(1, target.canvas.width);
    const height = Math.max(1, target.canvas.height);
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    const gl = this.gl;
    const vertexLength = vertices.length * 4;
    if (this.vertexData.length < vertexLength) this.vertexData = new Float32Array(vertexLength);
    if (this.indexData.length < triangles.length) this.indexData = new Uint32Array(triangles.length);
    const interleaved = this.vertexData;
    this.indexData.set(triangles);
    for (let index = 0; index < vertices.length; index += 1) {
      const vertex = vertices[index];
      const offset = index * 4;
      interleaved[offset] = vertex.x;
      interleaved[offset + 1] = vertex.y;
      interleaved[offset + 2] = vertex.u;
      interleaved[offset + 3] = vertex.v;
    }
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.program);
    gl.uniform2f(this.resolutionLocation, width, height);
    gl.uniform1f(this.opacityLocation, Math.min(1, Math.max(0, opacity)));
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    if (this.vertexCapacity < interleaved.byteLength) {
      gl.bufferData(gl.ARRAY_BUFFER, interleaved.byteLength, gl.STREAM_DRAW);
      this.vertexCapacity = interleaved.byteLength;
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, interleaved, 0, vertexLength);
    gl.enableVertexAttribArray(this.positionLocation);
    gl.vertexAttribPointer(this.positionLocation, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(this.texCoordLocation);
    gl.vertexAttribPointer(this.texCoordLocation, 2, gl.FLOAT, false, 16, 8);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    if (this.indexCapacity < this.indexData.byteLength) {
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.indexData.byteLength, gl.STREAM_DRAW);
      this.indexCapacity = this.indexData.byteLength;
    }
    gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, 0, this.indexData, 0, triangles.length);
    const texture = this.textureFor(image);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
    gl.drawElements(gl.TRIANGLES, triangles.length, gl.UNSIGNED_INT, 0);
    // Canvas drawImage consumes the WebGL surface; do not force a CPU/GPU fence here.
    target.save();
    target.setTransform(1, 0, 0, 1, 0, 0);
    target.globalAlpha = 1;
    target.globalCompositeOperation = blendMode;
    target.drawImage(this.canvas, 0, 0);
    target.restore();
    return true;
  }

  private textureFor(image: HTMLImageElement): WebGLTexture {
    const existing = this.textureByImage.get(image);
    if (existing) {
      // A parameter-shaded Canvas keeps its identity while its pixels change.
      if (image instanceof HTMLCanvasElement) {
        const gl = this.gl;
        gl.bindTexture(gl.TEXTURE_2D, existing);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
      }
      return existing;
    }
    const gl = this.gl;
    const texture = gl.createTexture();
    if (!texture) throw new Error("Could not create WebGL2 ArtMesh texture");
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    this.textures.add(texture);
    this.textureByImage.set(image, texture);
    return texture;
  }

  private createResources() {
    const gl = this.gl;
    const vertexShader = this.compileShader(gl.VERTEX_SHADER, `#version 300 es
      precision highp float;
      in vec2 a_position;
      in vec2 a_texCoord;
      uniform vec2 u_resolution;
      out vec2 v_texCoord;
      void main() {
        vec2 zeroToOne = a_position / u_resolution;
        vec2 clip = zeroToOne * 2.0 - 1.0;
        gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
        v_texCoord = vec2(a_texCoord.x, 1.0 - a_texCoord.y);
      }`);
    const fragmentShader = this.compileShader(gl.FRAGMENT_SHADER, `#version 300 es
      precision highp float;
      uniform sampler2D u_texture;
      uniform float u_opacity;
      in vec2 v_texCoord;
      out vec4 outColor;
      void main() {
        vec4 color = texture(u_texture, v_texCoord);
        outColor = color * u_opacity;
      }`);
    const program = gl.createProgram();
    if (!program) throw new Error("Could not create WebGL2 ArtMesh program");
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const message = gl.getProgramInfoLog(program) || "unknown link error";
      gl.deleteProgram(program);
      throw new Error(`Could not link WebGL2 ArtMesh program: ${message}`);
    }
    const vertexBuffer = gl.createBuffer();
    const indexBuffer = gl.createBuffer();
    const resolutionLocation = gl.getUniformLocation(program, "u_resolution");
    const opacityLocation = gl.getUniformLocation(program, "u_opacity");
    if (!vertexBuffer || !indexBuffer || !resolutionLocation || !opacityLocation) {
      gl.deleteProgram(program);
      throw new Error("Could not create WebGL2 ArtMesh buffers or uniforms");
    }
    gl.useProgram(program);
    gl.uniform1i(gl.getUniformLocation(program, "u_texture"), 0);
    return {
      program,
      vertexBuffer,
      indexBuffer,
      positionLocation: gl.getAttribLocation(program, "a_position"),
      texCoordLocation: gl.getAttribLocation(program, "a_texCoord"),
      resolutionLocation,
      opacityLocation
    };
  }

  private compileShader(type: number, source: string): WebGLShader {
    const shader = this.gl.createShader(type);
    if (!shader) throw new Error("Could not create WebGL2 ArtMesh shader");
    this.gl.shaderSource(shader, source);
    this.gl.compileShader(shader);
    if (!this.gl.getShaderParameter(shader, this.gl.COMPILE_STATUS)) {
      const message = this.gl.getShaderInfoLog(shader) || "unknown compile error";
      this.gl.deleteShader(shader);
      throw new Error(`Could not compile WebGL2 ArtMesh shader: ${message}`);
    }
    return shader;
  }
}

export function comparePixelBuffers(reference: ArrayLike<number>, candidate: ArrayLike<number>, width: number, height: number, threshold = 2, options: PixelParityOptions = {}): PixelParityResult {
  const pixelCount = Math.max(0, width * height);
  let differingPixels = 0;
  let maxChannelDelta = 0;
  let totalChannelDelta = 0;
  const length = Math.min(reference.length, candidate.length);
  for (let offset = 0; offset + 3 < length; offset += 4) {
    let pixelDelta = 0;
    for (let channel = 0; channel < 4; channel += 1) {
      const delta = Math.abs((reference[offset + channel] ?? 0) - (candidate[offset + channel] ?? 0));
      pixelDelta = Math.max(pixelDelta, delta);
      maxChannelDelta = Math.max(maxChannelDelta, delta);
      totalChannelDelta += delta;
    }
    if (pixelDelta > threshold) differingPixels += 1;
  }
  const channelCount = Math.max(1, Math.floor(length / 4) * 4);
  const differingPixelRatio = pixelCount ? differingPixels / pixelCount : 0;
  const meanChannelDelta = totalChannelDelta / channelCount;
  const gate = {
    maxDifferingPixelRatio: clampParityRatio(options.maxDifferingPixelRatio ?? 0),
    maxMeanChannelDelta: clampParityMean(options.maxMeanChannelDelta ?? 255)
  };
  return { width, height, differingPixels, differingPixelRatio, maxChannelDelta, meanChannelDelta, gate, pass: differingPixelRatio <= gate.maxDifferingPixelRatio && meanChannelDelta <= gate.maxMeanChannelDelta };
}

function clampParityRatio(value: number): number { return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0; }
function clampParityMean(value: number): number { return Number.isFinite(value) ? Math.max(0, Math.min(255, value)) : 0; }
export function webglMeshShaderContract(): { version: "webgl2"; premultipliedAlpha: true; filtering: "linear"; mipmap: false } {
  return { version: "webgl2", premultipliedAlpha: true, filtering: "linear", mipmap: false };
}
