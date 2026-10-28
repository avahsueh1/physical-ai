// Draws the vehicle world: table, track, trail, robot body, sensors, wheels.
export function drawVehicle(canvas, v) {
  const ctx = canvas.getContext('2d');
  const cfg = v.config;
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth,
    H = canvas.clientHeight;
  if (canvas.width !== W * dpr || canvas.height !== H * dpr) {
    canvas.width = W * dpr;
    canvas.height = H * dpr;
  }
  const css = getComputedStyle(canvas);
  const col = (n) => css.getPropertyValue(n).trim();
  const scale = Math.min(W / cfg.width, H / cfg.height);
  ctx.setTransform(
    dpr * scale,
    0,
    0,
    dpr * scale,
    (dpr * (W - cfg.width * scale)) / 2,
    (dpr * (H - cfg.height * scale)) / 2,
  );
  ctx.clearRect(-1000, -1000, 4000, 4000);
  ctx.fillStyle = col('--table');
  ctx.fillRect(0, 0, cfg.width, cfg.height);
  // Track
  ctx.beginPath();
  cfg.track.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.closePath();
  ctx.strokeStyle = col('--line-track');
  ctx.lineWidth = cfg.lineWidth;
  ctx.stroke();
  // Trail
  if (v.trail.length > 1) {
    ctx.beginPath();
    v.trail.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.strokeStyle = col('--trail');
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  // Body
  ctx.save();
  ctx.translate(v.x, v.y);
  ctx.rotate(v.heading);
  const r = cfg.radius,
    half = cfg.wheelBase / 2;
  const wheel = (side, power) => {
    ctx.fillStyle = power > 0 ? col('--on') : power < 0 ? col('--rev') : col('--wheel');
    ctx.fillRect(-7, side * half - 3, 14, 6);
  };
  ctx.fillStyle = v.sensors.bump ? col('--rev') : col('--robot');
  ctx.beginPath();
  ctx.roundRect(-r + 2, -r + 3, r * 2 - 2, r * 2 - 6, 5);
  ctx.fill();
  wheel(-1, v.motors.left);
  wheel(1, v.motors.right);
  ctx.restore();
  // Sensors
  const s = v.sensorPositions();
  for (const [p, on] of [
    [s.left, v.sensors.lineL],
    [s.right, v.sensors.lineR],
  ]) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = on ? col('--on') : col('--table');
    ctx.strokeStyle = col('--on');
    ctx.lineWidth = 1.5;
    ctx.fill();
    ctx.stroke();
  }
}
