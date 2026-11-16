// Interpolate between received poses only; never invent a route or extrapolate telemetry.
const angleDelta = (from, to) => Math.atan2(Math.sin(to - from), Math.cos(to - from));

export function isDeviceRunning(device) {
  return device.online !== false && device.health?.level !== 'bad'
    && ['run', 'running'].includes(device.status);
}

export function advanceDeviceMotion(model, now, reducedMotion = false) {
  const motion = model.userData.motion;
  if (!motion) return;
  const progress = reducedMotion ? 1 : Math.min(1, Math.max(0, (now - motion.startedAt) / motion.duration));
  model.position.x = motion.from.x + (motion.to.x - motion.from.x) * progress;
  model.position.z = motion.from.z + (motion.to.z - motion.from.z) * progress;
  model.rotation.y = motion.from.yaw + angleDelta(motion.from.yaw, motion.to.yaw) * progress;
}

export function syncDeviceMotion(model, device, now) {
  const to = { x: device.position.x, z: -device.position.y, yaw: (device.position.yaw || 0) * Math.PI / 180 };
  const previous = model.userData.motion;
  const moving = device.kind === 'agv' && isDeviceRunning(device);
  if (!previous || !moving || Math.hypot(to.x - model.position.x, to.z - model.position.z) > 6) {
    model.position.set(to.x, 0, to.z);
    model.rotation.y = to.yaw;
    model.userData.motion = { from: to, to, startedAt: now, sampledAt: now, duration: 1 };
    return;
  }
  // Selection changes and repeated snapshots must not restart an ongoing movement.
  if (previous.to.x === to.x && previous.to.z === to.z && previous.to.yaw === to.yaw) return;
  advanceDeviceMotion(model, now);
  model.userData.motion = {
    from: { x: model.position.x, z: model.position.z, yaw: model.rotation.y },
    to, startedAt: now, sampledAt: now,
    duration: Math.min(5000, Math.max(160, now - previous.sampledAt)),
  };
}
