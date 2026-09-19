/**
 * Builds sponge meshes off the main thread. Level 4 is ~160k cubes, and doing
 * that work inline would freeze the UI on a phone for long enough to look like
 * a crash — here the spinner keeps animating and touch stays responsive.
 */
import { buildSurfaceMesh } from './menger.js';

self.onmessage = (event) => {
  const { id, level } = event.data;
  try {
    const mesh = buildSurfaceMesh(level);
    self.postMessage({ id, mesh }, [
      mesh.positions.buffer,
      mesh.normals.buffer,
      mesh.indices.buffer,
    ]);
  } catch (error) {
    self.postMessage({ id, error: String(error && error.message || error) });
  }
};
