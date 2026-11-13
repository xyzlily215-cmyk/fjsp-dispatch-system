import * as THREE from 'three';

function texture(width, height, draw) {
  if (typeof document === 'undefined') {
    const map = new THREE.DataTexture(new Uint8Array([40, 55, 65, 255]), 1, 1, THREE.RGBAFormat);
    map.needsUpdate = true;
    return map;
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  draw(canvas.getContext('2d'), width, height);
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 4;
  return map;
}

export function createPanelTexture() {
  return texture(512, 384, (ctx, w, h) => {
    ctx.fillStyle = '#14232d';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#287aa1';
    ctx.fillRect(0, 0, w, 52);
    ctx.fillStyle = '#edf7fb';
    ctx.font = '600 25px sans-serif';
    ctx.fillText('FJSP CNC', 22, 35);
    ctx.font = '16px sans-serif';
    ctx.fillText('VMC 850', 390, 34);
    ctx.fillStyle = '#213844';
    ctx.fillRect(18, 72, 476, 92);
    ctx.fillStyle = '#7f9ba9';
    ctx.font = '14px sans-serif';
    ctx.fillText('POSITION / MACHINE', 34, 96);
    ctx.fillStyle = '#a8e1e8';
    ctx.font = '24px monospace';
    ['X', 'Y', 'Z'].forEach((axis, i) => {
      ctx.fillText(axis, 36 + i * 156, 137);
      ctx.fillText('—', 84 + i * 156, 137);
    });
    const labels = ['PROGRAM', 'SPINDLE', 'FEED', 'LOAD'];
    labels.forEach((label, i) => {
      const x = 18 + (i % 2) * 242;
      const y = 182 + Math.floor(i / 2) * 78;
      ctx.fillStyle = '#1d303b';
      ctx.fillRect(x, y, 230, 62);
      ctx.fillStyle = '#7f9ba9';
      ctx.font = '13px sans-serif';
      ctx.fillText(label, x + 14, y + 22);
      ctx.fillStyle = '#d2e6eb';
      ctx.font = '20px monospace';
      ctx.fillText('—', x + 14, y + 48);
    });
    ['AUTO', 'EDIT', 'MDI', 'JOG', 'HOME'].forEach((label, i) => {
      ctx.fillStyle = i === 0 ? '#287aa1' : '#2b424f';
      ctx.fillRect(18 + i * 96, 350, 88, 22);
      ctx.fillStyle = '#dcebf0';
      ctx.font = '11px sans-serif';
      ctx.fillText(label, 29 + i * 96, 365);
    });
  });
}

export function createNameplateTexture() {
  return texture(512, 160, (ctx, w, h) => {
    ctx.fillStyle = '#e9edef';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#337ecc';
    ctx.fillRect(0, 0, 24, h);
    ctx.fillStyle = '#263640';
    ctx.font = '600 54px sans-serif';
    ctx.fillText('VMC-850', 50, 72);
    ctx.fillStyle = '#65727c';
    ctx.font = '19px sans-serif';
    ctx.fillText('FLEXIBLE MACHINING CENTER', 52, 116);
    ctx.strokeStyle = '#9aa8b1';
    ctx.lineWidth = 3;
    ctx.strokeRect(2, 2, w - 4, h - 4);
  });
}

export function createWarningTexture() {
  return texture(256, 256, (ctx, w, h) => {
    ctx.fillStyle = '#e5bd32';
    ctx.beginPath();
    ctx.moveTo(w / 2, 12);
    ctx.lineTo(w - 14, h - 18);
    ctx.lineTo(14, h - 18);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#263640';
    ctx.lineWidth = 12;
    ctx.stroke();
    ctx.fillStyle = '#263640';
    ctx.font = '700 142px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('!', w / 2, 198);
  });
}
