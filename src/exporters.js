/**
 * Mesh exporters for the sponge surface. Dependency-free and byte-oriented so
 * they can be unit-tested in Node and used directly from the browser.
 */

/** Bytes a binary STL of this mesh will occupy: 84 header + 50 per triangle. */
export function stlByteLength(mesh) {
  return 84 + 50 * mesh.faceCount * 2;
}

/**
 * Binary STL. Every quad becomes two triangles that reuse the quad's normal,
 * which is exact here because each face is axis-aligned and flat.
 *
 * @param {{positions: Float32Array, normals: Float32Array, indices: Uint32Array, faceCount: number}} mesh
 * @param {number} scale Edge length of the sponge's bounding cube, in mm.
 * @returns {ArrayBuffer}
 */
export function toBinarySTL(mesh, scale = 100) {
  const { positions, normals, indices } = mesh;
  const triangles = indices.length / 3;
  const buffer = new ArrayBuffer(84 + 50 * triangles);
  const view = new DataView(buffer);

  const header = 'Menger sponge L' + mesh.level + ' - FractalGenVIBE';
  for (let i = 0; i < Math.min(header.length, 80); i++) {
    view.setUint8(i, header.charCodeAt(i));
  }
  view.setUint32(80, triangles, true);

  let offset = 84;
  for (let t = 0; t < triangles; t++) {
    const a = indices[t * 3], b = indices[t * 3 + 1], c = indices[t * 3 + 2];
    view.setFloat32(offset, normals[a * 3], true);
    view.setFloat32(offset + 4, normals[a * 3 + 1], true);
    view.setFloat32(offset + 8, normals[a * 3 + 2], true);
    offset += 12;
    for (const v of [a, b, c]) {
      view.setFloat32(offset, positions[v * 3] * scale, true);
      view.setFloat32(offset + 4, positions[v * 3 + 1] * scale, true);
      view.setFloat32(offset + 8, positions[v * 3 + 2] * scale, true);
      offset += 12;
    }
    view.setUint16(offset, 0, true); // attribute byte count
    offset += 2;
  }
  return buffer;
}

/**
 * Wavefront OBJ, streamed in chunks so a level-4 mesh never has to exist as one
 * giant string. Returns the chunks; join them or hand them straight to a Blob.
 *
 * @param {{positions: Float32Array, normals: Float32Array, indices: Uint32Array}} mesh
 * @param {number} scale
 * @returns {string[]}
 */
export function toOBJChunks(mesh, scale = 100) {
  const { positions, indices } = mesh;
  const vertexCount = positions.length / 3;
  const chunks = [`# Menger sponge level ${mesh.level} - FractalGenVIBE\n`];
  const lines = [];

  for (let v = 0; v < vertexCount; v++) {
    lines.push(
      `v ${(positions[v * 3] * scale).toFixed(4)} ` +
      `${(positions[v * 3 + 1] * scale).toFixed(4)} ` +
      `${(positions[v * 3 + 2] * scale).toFixed(4)}`
    );
    if (lines.length >= 8192) {
      chunks.push(lines.join('\n') + '\n');
      lines.length = 0;
    }
  }
  for (let t = 0; t < indices.length; t += 3) {
    // OBJ indices are 1-based.
    lines.push(`f ${indices[t] + 1} ${indices[t + 1] + 1} ${indices[t + 2] + 1}`);
    if (lines.length >= 8192) {
      chunks.push(lines.join('\n') + '\n');
      lines.length = 0;
    }
  }
  if (lines.length) chunks.push(lines.join('\n') + '\n');
  return chunks;
}

/** Human-readable byte size, for warning before a download starts. */
export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}
