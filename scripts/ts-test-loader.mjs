import fs from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

export async function resolve(specifier, context, nextResolve) {
  if (context.parentURL?.startsWith("file:") && specifier.startsWith(".")) {
    const candidate = new URL(specifier, context.parentURL);
    if (!candidate.pathname.endsWith(".ts") && !candidate.pathname.endsWith(".js")) {
      try {
        await fs.access(fileURLToPath(candidate) + ".ts");
        return { shortCircuit: true, url: pathToFileURL(fileURLToPath(candidate) + ".ts").href };
      } catch {}
    }
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.endsWith(".ts")) {
    const source = await fs.readFile(fileURLToPath(url), "utf8");
    const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }, fileName: fileURLToPath(url) });
    return { format: "module", shortCircuit: true, source: output.outputText };
  }
  return nextLoad(url, context);
}
