/**
 * Builds sponge meshes off the main thread. A view can run to a few hundred
 * thousand cubes, and doing that work inline would freeze the UI on a phone
 * for long enough to look like a crash — here the page stays responsive.
 *
 * `view` builds what the camera sees for display; `region` builds a uniform,
 * printable slice for export.
 */
import { buildViewMesh, buildRegionMesh } from './menger.js';

self.onmessage = (event) => {
  const { id, kind, params } = event.data;
  try {
    const mesh = kind === 'region' ? buildRegionMesh(params) : buildViewMesh(params);
    const transfer = [mesh.positions.buffer, mesh.normals.buffer, mesh.indices.buffer];
    if (mesh.shade) transfer.push(mesh.shade.buffer);
    self.postMessage({ id, mesh }, transfer);
  } catch (error) {
    self.postMessage({ id, error: String(error && error.message || error) });
  }
};
