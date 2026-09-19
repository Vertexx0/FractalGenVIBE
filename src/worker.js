/**
 * Builds sponge meshes off the main thread. A region can run to 200k cubes, and
 * doing that work inline would freeze the UI on a phone for long enough to look
 * like a crash — here the spinner keeps animating and touch stays responsive.
 */
import { buildRegionMesh } from './menger.js';

self.onmessage = (event) => {
  const { id, params } = event.data;
  try {
    const mesh = buildRegionMesh(params);
    self.postMessage({ id, mesh }, [
      mesh.positions.buffer,
      mesh.normals.buffer,
      mesh.indices.buffer,
    ]);
  } catch (error) {
    self.postMessage({ id, error: String(error && error.message || error) });
  }
};
