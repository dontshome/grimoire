// Generates build/icon.ico by drawing the rune on a Chromium canvas in an
// offscreen window (reliable pixels), then packing the PNGs into an .ico.
// Run with: electron build/make-icon.js
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");

const SIZES = [16, 24, 32, 48, 64, 128, 256];

const drawPage = `<!doctype html><meta charset="utf8"><body style="margin:0">
<canvas id="c"></canvas>
<script>
function draw(size){
  const cv=document.getElementById('c'); cv.width=size; cv.height=size;
  const x=cv.getContext('2d'); const c=size/2;
  // disc
  const g=x.createRadialGradient(size*0.38,size*0.32,size*0.05,c,c,size*0.5);
  g.addColorStop(0,'#2a2410'); g.addColorStop(1,'#12100a');
  x.beginPath(); x.arc(c,c,size*0.46,0,Math.PI*2); x.fillStyle=g; x.fill();
  x.lineWidth=Math.max(1,size*0.03); x.strokeStyle='rgba(200,162,74,0.75)'; x.stroke();
  // four-point sparkle
  const sg=x.createRadialGradient(c,size*0.4,0,c,c,size*0.35);
  sg.addColorStop(0,'#ffe9a8'); sg.addColorStop(1,'#c8a24a');
  x.beginPath();
  for(let i=0;i<8;i++){
    const ang=Math.PI/4*i-Math.PI/2;
    const rad=i%2===0?size*0.31:size*0.11;
    const px=c+Math.cos(ang)*rad, py=c+Math.sin(ang)*rad;
    i===0?x.moveTo(px,py):x.lineTo(px,py);
  }
  x.closePath(); x.fillStyle=sg; x.fill();
  return cv.toDataURL('image/png');
}
</script></body>`;

function buildIco(pngs) {
  const count = pngs.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);
  const dir = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;
  pngs.forEach((png, i) => {
    const size = SIZES[i] >= 256 ? 0 : SIZES[i];
    const b = i * 16;
    dir.writeUInt8(size, b);
    dir.writeUInt8(size, b + 1);
    dir.writeUInt16LE(1, b + 4);
    dir.writeUInt16LE(32, b + 6);
    dir.writeUInt32LE(png.length, b + 8);
    dir.writeUInt32LE(offset, b + 12);
    offset += png.length;
  });
  return Buffer.concat([header, dir, ...pngs]);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 300, height: 300, show: false, webPreferences: { offscreen: true } });
  await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(drawPage));
  try {
    const pngs = [];
    for (const size of SIZES) {
      const dataUrl = await win.webContents.executeJavaScript(`draw(${size})`);
      pngs.push(Buffer.from(dataUrl.split(",")[1], "base64"));
    }
    const bad = pngs.filter((p) => p.length < 100).length;
    const ico = buildIco(pngs);
    fs.writeFileSync(path.join(__dirname, "icon.ico"), ico);
    fs.writeFileSync(path.join(__dirname, "icon.png"), pngs[pngs.length - 1]);
    console.log(`wrote icon.ico ${ico.length} bytes; smallest png ${Math.min(...pngs.map(p => p.length))}; empty ${bad}`);
  } catch (e) {
    console.error("ICON FAIL", e);
  }
  app.quit();
});
