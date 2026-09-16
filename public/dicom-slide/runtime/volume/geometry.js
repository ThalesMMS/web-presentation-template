(function (global) {
  "use strict";

  const internal = global.__DicomSlideInternal || (global.__DicomSlideInternal = {});
  const volume = internal.volume || (internal.volume = {});

  function normalizeVector(vector, fallback) {
    const length = Math.hypot(...vector);
    return Number.isFinite(length) && length > Number.EPSILON
      ? vector.map((value) => value / length)
      : fallback.slice();
  }

  function crossVector(left, right) {
    return [
      left[1] * right[2] - left[2] * right[1],
      left[2] * right[0] - left[0] * right[2],
      left[0] * right[1] - left[1] * right[0],
    ];
  }

  function dotVector(left, right) {
    return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
  }

  function rotateVector(vector, axis, angle) {
    const unitAxis = normalizeVector(axis, [0, 0, 1]);
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    const crossed = crossVector(unitAxis, vector);
    const dotted = dotVector(unitAxis, vector);
    return vector.map((value, index) =>
      value * cosine + crossed[index] * sine + unitAxis[index] * dotted * (1 - cosine));
  }

  function buildOrbitCamera(cameraFrame, yaw, pitch) {
    const initialOffset = normalizeVector(cameraFrame.offsetDirection, [0, -1, 0]);
    const initialUp = normalizeVector(cameraFrame.up, [0, 0, 1]);
    const yawedDirection = normalizeVector(rotateVector(initialOffset, initialUp, yaw), initialOffset);
    const yawedUp = normalizeVector(rotateVector(initialUp, initialUp, yaw), initialUp);
    const yawedForward = normalizeVector(yawedDirection.map((value) => -value), [0, 1, 0]);
    const right = normalizeVector(crossVector(yawedForward, yawedUp), [1, 0, 0]);
    const offsetDirection = normalizeVector(rotateVector(yawedDirection, right, pitch), yawedDirection);
    const up = normalizeVector(rotateVector(yawedUp, right, pitch), yawedUp);
    const forward = normalizeVector(offsetDirection.map((value) => -value), yawedForward);
    const finalRight = normalizeVector(crossVector(forward, up), right);
    const finalUp = normalizeVector(crossVector(finalRight, forward), up);
    return {
      offsetDirection,
      up: finalUp,
      rotation: new Float32Array([
        finalRight[0], finalRight[1], finalRight[2],
        finalUp[0], finalUp[1], finalUp[2],
        forward[0], forward[1], forward[2],
      ]),
    };
  }

  function buildPlaneDefinitions(affine, coordinateSystem) {
    const worldToVoxel = new Array(3);
    const claimed = new Set();
    if (Array.isArray(affine) && affine.length === 16) {
      for (let voxelAxis = 0; voxelAxis < 3; voxelAxis += 1) {
        const vector = [affine[voxelAxis], affine[4 + voxelAxis], affine[8 + voxelAxis]];
        let worldAxis = 0;
        for (let axis = 1; axis < 3; axis += 1) {
          if (Math.abs(vector[axis]) > Math.abs(vector[worldAxis])) worldAxis = axis;
        }
        if (!claimed.has(worldAxis) && Math.abs(vector[worldAxis]) > 1e-6) {
          worldToVoxel[worldAxis] = { axis: voxelAxis, sign: vector[worldAxis] >= 0 ? 1 : -1 };
          claimed.add(worldAxis);
        }
      }
    }
    if ([0, 1, 2].some((worldAxis) => !worldToVoxel[worldAxis])) {
      worldToVoxel[0] = { axis: 0, sign: 1 };
      worldToVoxel[1] = { axis: 1, sign: 1 };
      worldToVoxel[2] = { axis: 2, sign: 1 };
    }
    const screenSigns = String(coordinateSystem || "LPS").toUpperCase() === "LPS"
      ? [1, 1, -1]
      : [-1, -1, -1];
    const screenAxis = (worldAxis) => Object.assign({}, worldToVoxel[worldAxis], { screenSign: screenSigns[worldAxis] });
    return {
      axial: { fixed: worldToVoxel[2], u: screenAxis(0), v: screenAxis(1) },
      coronal: { fixed: worldToVoxel[1], u: screenAxis(0), v: screenAxis(2) },
      sagittal: { fixed: worldToVoxel[0], u: screenAxis(1), v: screenAxis(2) },
    };
  }

  function buildAffineLPS(manifest) {
    const orientation = Array.isArray(manifest.orientationLPS) && manifest.orientationLPS.length >= 6
      ? manifest.orientationLPS.slice(0, 6).map(Number)
      : [1, 0, 0, 0, 1, 0];
    const row = normalizeVector(orientation.slice(0, 3), [1, 0, 0]);
    const column = normalizeVector(orientation.slice(3, 6), [0, 1, 0]);
    const normal = normalizeVector(crossVector(row, column), [0, 0, 1]);
    const spacing = manifest.spacing || {};
    const sx = Math.abs(Number(spacing.column)) || 1;
    const sy = Math.abs(Number(spacing.row)) || 1;
    const sz = Math.abs(Number(spacing.slice)) || 1;
    return [
      row[0] * sx, column[0] * sy, normal[0] * sz, 0,
      row[1] * sx, column[1] * sy, normal[1] * sz, 0,
      row[2] * sx, column[2] * sy, normal[2] * sz, 0,
      0, 0, 0, 1,
    ];
  }


  volume.geometry = {
    normalizeVector,
    crossVector,
    dotVector,
    rotateVector,
    buildOrbitCamera,
    buildPlaneDefinitions,
    buildAffineLPS,
  };
})(window);
