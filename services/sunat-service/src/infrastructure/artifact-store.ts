import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { Inject, Injectable, Optional } from "@nestjs/common";

export function assertDocumentId(documentId: string) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      documentId,
    )
  )
    throw new Error("documentId inválido");
}
function inside(root: string, path: string) {
  const child = relative(root, path);
  if (
    !child ||
    child === ".." ||
    child.startsWith(`..${sep}`) ||
    isAbsolute(child)
  )
    throw new Error("Ruta de artefacto no permitida");
}
export const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;

export const SUNAT_ARTIFACTS_ROOT=Symbol('Explicit SUNAT artifact root');
@Injectable()
export class ArtifactStore {
  constructor(@Optional() @Inject(SUNAT_ARTIFACTS_ROOT) private readonly explicitRoot?:string){
    if(explicitRoot!==undefined&&(!isAbsolute(explicitRoot)||resolve(explicitRoot)===resolve(explicitRoot, '..')))throw Error('SUNAT_ARTIFACT_ROOT_REQUIRED');
  }
  private root() {
    return this.explicitRoot===undefined ? resolve(process.env.ARTIFACTS_ROOT ?? "/data/artifacts") : resolve(this.explicitRoot);
  }
  putUnsignedXml(documentId: string, fileName: string, xml: string) {
    return this.put(documentId, `${fileName}.xml`, Buffer.from(xml, "utf8"));
  }
  async put(documentId: string, fileName: string, bytes: Buffer) {
    assertDocumentId(documentId);
    if (
      !/^[A-Za-z0-9_-]{1,120}\.(xml|pdf|zip)$/.test(fileName) ||
      bytes.length > MAX_ARTIFACT_BYTES ||
      !bytes.length
    )
      throw new Error("Nombre o tamaño de artefacto inválido");
    const root = this.root();
    const directory = join(root, documentId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const resolvedRoot = await realpath(root);
    const resolvedDirectory = await realpath(directory);
    if (resolvedDirectory !== join(resolvedRoot, documentId))
      throw new Error("Directorio de artefacto no permitido");
    inside(resolvedRoot, resolvedDirectory);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const storageKey = join(documentId, `${sha256}-${fileName}`);
    const temporary = join(directory, `${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, join(root, storageKey));
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
    return { storageKey, sha256, sizeBytes: bytes.length };
  }
  async read(
    documentId: string,
    artifact: {
      storageKey: string;
      sha256: string;
      sizeBytes: bigint | number;
    },
  ) {
    assertDocumentId(documentId);
    const root = this.root();
    const path = resolve(root, artifact.storageKey);
    inside(join(root, documentId), path);
    const resolvedRoot = await realpath(root);
    const resolvedDirectory = await realpath(join(root, documentId));
    if (resolvedDirectory !== join(resolvedRoot, documentId))
      throw new Error("Directorio de artefacto no permitido");
    inside(resolvedDirectory, await realpath(path));
    const handle = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const stat = await handle.stat();
      if (
        !stat.isFile() ||
        stat.size > MAX_ARTIFACT_BYTES ||
        BigInt(stat.size) !== BigInt(artifact.sizeBytes)
      )
        throw new Error("Artefacto inválido");
      const bytes = await handle.readFile();
      if (createHash("sha256").update(bytes).digest("hex") !== artifact.sha256)
        throw new Error("Integridad del artefacto inválida");
      return bytes;
    } finally {
      await handle.close();
    }
  }
}
