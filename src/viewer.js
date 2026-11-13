import * as THREE from 'three';
import { OrbitControls } from './OrbitControls.js';
import { publicFetch, setDownloadProgressHandler } from './public-data.js';

const $ = id => document.getElementById(id);
const state = {
  plots: [],
  plot: null,
  trees: [],
  selected: null,
  detail: null,
  generation: 0,
  controller: null,
  detailController: null,
  mode: 'plot',
  overviewManifest: null,
};
const SRGB_TO_LINEAR = Float32Array.from({ length: 256 }, (_, i) => {
  const v = i / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
});
let autoDetailTimer;
const densityLabel = value =>
  ({
    high: 'ความหนาแน่นสูง',
    medium: 'ความหนาแน่นกลาง',
    low: 'ความหนาแน่นต่ำ',
  })[value] || 'ยังไม่ระบุความหนาแน่น';
const colourLabel = value =>
  ({ red: 'สีแดง', green: 'สีเขียว', yellow: 'สีเหลือง' })[value] ||
  'ยังไม่ระบุสี';
const format = (value, digits = 2) =>
  value == null || !Number.isFinite(Number(value))
    ? '—'
    : Number(value).toLocaleString('en-US', {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      });
const shortID = id => id?.split('_').slice(-1)[0] || '—';
const apiPath = (plot = state.plot?.plot_id, tree = state.selected) =>
  `/api/plots/${encodeURIComponent(plot)}/trees${tree ? '/' + encodeURIComponent(tree) : ''}`;
function status(message, error = false) {
  $('status').textContent = message;
  $('status').classList.toggle('error', error);
}
async function request(path, options = {}) {
  const response = await publicFetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(`ไม่สามารถอ่านผลจากระบบ (${response.status})`);
  }
  if (!response.ok) {
    let detail = data.detail || 'ไม่สามารถดำเนินการได้';
    if (typeof detail !== 'string') detail = JSON.stringify(detail);
    throw new Error(detail);
  }
  return data;
}
function make(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}
function showLoading(visible, message) {
  $('viewer-loading').hidden = !visible;
  if (message) $('viewer-loading').querySelector('span').textContent = message;
}
function clearSelectionDisplay() {
  state.detailController?.abort();
  clearTimeout(autoDetailTimer);
  state.activeDetailKey = null;
  if (viewer) {
    for (const group of [
      viewer.context,
      viewer.measurement,
      viewer.markers,
      viewer.labels,
      viewer.details,
    ])
      viewer.clear(group);
    viewer.currentFit = null;
    viewer.markerTreeIDs = [];
    viewer.markerPoints = null;
    viewer.overviewPositions = null;
    viewer.overviewRGB = null;
    viewer.overviewPointObject = null;
  }
  $('focus-measurement').disabled = true;
  $('plot-source-count').textContent = '—';
  $('plot-render-count').textContent = '—';
  $('plot-tree-count').textContent = '—';
  for (const id of [
    'diameter-value',
    'circumference-value',
    'height-value',
    'coverage-value',
    'rmse-value',
    'inlier-value',
  ])
    $(id).textContent = '—';
  $('dbh-value').textContent = 'ยังไม่ยืนยัน';
  $('dbh-label').textContent = 'DBH ผ่านเกณฑ์';
  $('point-count').textContent = '— จุด';
  $('cloud-label').textContent = 'กำลังโหลดข้อมูลที่เลือก';
  $('result-state').textContent = 'กำลังโหลด';
  $('selected-qc').textContent = '3D REVIEW';
  $('revision-label').textContent = '—';
}
class CloudViewer {
  constructor() {
    this.canvas = $('cloud-canvas');
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#0e1d24');
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 500);
    this.camera.up.set(0, 0, 1);
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: false,
    });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.depthCue = false;
    $('depth-cue').checked = false;
    this.pointSize = 2;
    this.colorMode = 'rgb';
    this.clipUniform = { value: 1e20 };
    this.createPostprocess();
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.09;
    this.controls.minDistance = 0.15;
    this.controls.maxDistance = 30;
    this.controls.addEventListener('end', () => scheduleAutoDetail());
    this.root = new THREE.Group();
    this.context = new THREE.Group();
    this.measurement = new THREE.Group();
    this.markers = new THREE.Group();
    this.labels = new THREE.Group();
    this.details = new THREE.Group();
    this.root.add(
      this.context,
      this.measurement,
      this.markers,
      this.labels,
      this.details
    );
    this.scene.add(this.root);
    this.origin = new THREE.Vector3();
    this.planeVisible = true;
    this.cloudVisible = true;
    this.currentFit = null;
    this.mode = 'tree';
    this.scene.background = new THREE.Color('#0e1d24');
    this.scene.fog = null;
    this.plotBounds = null;
    this.labelsVisible = false;
    this.markerTreeIDs = [];
    this.markerPoints = null;
    this.grid = new THREE.GridHelper(8, 32, '#31524d', '#213c3f');
    this.grid.rotation.x = Math.PI / 2;
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.6;
    this.scene.add(this.grid);
    this.axes = new THREE.AxesHelper(0.45);
    this.axes.position.set(-1.7, -1.7, 0.01);
    this.scene.add(this.axes);
    this.pointerDown = null;
    this.canvas.addEventListener('pointerdown', event => {
      this.pointerDown = [event.clientX, event.clientY];
    });
    this.canvas.addEventListener('pointerup', event => {
      if (
        this.mode !== 'plot' ||
        !this.markers.visible ||
        !this.markerPoints ||
        !this.pointerDown ||
        Math.hypot(
          event.clientX - this.pointerDown[0],
          event.clientY - this.pointerDown[1]
        ) > 5
      )
        return;
      const rect = this.canvas.getBoundingClientRect();
      const cursor = new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        (-(event.clientY - rect.top) / rect.height) * 2 + 1
      );
      const ray = new THREE.Raycaster();
      ray.params.Points.threshold = (this.plotSpan || 100) * 0.008;
      ray.setFromCamera(cursor, this.camera);
      const hits = ray
        .intersectObject(this.markerPoints, false)
        .sort((a, b) => a.distanceToRay - b.distanceToRay);
      if (hits.length) {
        const tree = this.markerTreeIDs[hits[0].index];
        if (tree) selectTree(tree);
      }
    });
    this.resizeObserver = new ResizeObserver(() => {
      if (this.resizeFrame) return;
      this.resizeFrame = requestAnimationFrame(() => {
        this.resizeFrame = null;
        this.resize();
      });
    });
    this.resizeObserver.observe($('viewer-wrap'));
    this.resize();
    this.reset();
    const animate = () => {
      requestAnimationFrame(animate);
      this.controls.update();
      this.render();
    };
    animate();
  }
  createPostprocess() {
    try {
      this.postTarget = new THREE.WebGLRenderTarget(1, 1, {
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        depthBuffer: true,
        stencilBuffer: false,
      });
      this.postTarget.texture.colorSpace = THREE.LinearSRGBColorSpace;
      this.postTarget.depthTexture = new THREE.DepthTexture(
        1,
        1,
        THREE.UnsignedIntType
      );
      this.postTarget.depthTexture.format = THREE.DepthFormat;
      this.postUniforms = {
        colorMap: { value: this.postTarget.texture },
        depthMap: { value: this.postTarget.depthTexture },
        resolution: { value: new THREE.Vector2(1, 1) },
        nearPlane: { value: 0.1 },
        farPlane: { value: 500 },
        strength: { value: 1.25 },
      };
      const material = new THREE.ShaderMaterial({
        uniforms: this.postUniforms,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
        vertexShader: `varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0.0,1.0);}`,
        fragmentShader: `precision highp float;
        varying vec2 vUv;uniform sampler2D colorMap;uniform sampler2D depthMap;uniform vec2 resolution;uniform float nearPlane;uniform float farPlane;uniform float strength;
        float linearDepth(float d){float z=d*2.0-1.0;return 2.0*nearPlane*farPlane/(farPlane+nearPlane-z*(farPlane-nearPlane));}
        void main(){vec3 color=texture2D(colorMap,vUv).rgb;float d=texture2D(depthMap,vUv).x;float response=0.0;
          if(d<.999999){float center=log2(max(linearDepth(d),.0001));vec2 pixel=2.0/resolution;
            for(int i=0;i<8;i++){float angle=float(i)*.78539816339;vec2 uv=vUv+vec2(cos(angle),sin(angle))*pixel;float other=texture2D(depthMap,uv).x;
              if(other<.999999)response+=max(0.0,center-log2(max(linearDepth(other),.0001)));}
            color*=exp(-strength*response*12.0);}
          vec3 encoded=mix(color*12.92,1.055*pow(max(color,vec3(0.0)),vec3(1.0/2.4))-.055,step(vec3(.0031308),color));gl_FragColor=vec4(encoded,1.0);}`,
      });
      this.postScene = new THREE.Scene();
      this.postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
      this.postScene.add(
        new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material)
      );
    } catch (error) {
      this.postTarget = null;
      console.warn(
        'Depth cue unavailable; displaying direct RGB point cloud',
        error
      );
    }
  }
  render() {
    if (this.mode === 'plot' && this.depthCue && this.postTarget) {
      this.postUniforms.nearPlane.value = this.camera.near;
      this.postUniforms.farPlane.value = this.camera.far;
      this.renderer.setRenderTarget(this.postTarget);
      this.renderer.render(this.scene, this.camera);
      this.renderer.setRenderTarget(null);
      this.renderer.render(this.postScene, this.postCamera);
    } else this.renderer.render(this.scene, this.camera);
  }
  resize() {
    const box = $('viewer-wrap').getBoundingClientRect();
    if (box.width < 1 || box.height < 1) return;
    const width = Math.max(1, Math.floor(box.width));
    const height = Math.max(1, Math.floor(box.height));
    if (this.viewportWidth === width && this.viewportHeight === height) return;
    this.viewportWidth = width;
    this.viewportHeight = height;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    if (this.postTarget) {
      const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
      this.postTarget.setSize(size.x, size.y);
      this.postUniforms.resolution.value.copy(size);
    }
  }
  clear(group) {
    while (group.children.length) {
      const child = group.children[0];
      group.remove(child);
      child.traverse(item => {
        item.geometry?.dispose();
        const materials = Array.isArray(item.material)
          ? item.material
          : [item.material];
        for (const material of materials) {
          material?.map?.dispose();
          material?.dispose();
        }
      });
    }
  }
  calculateCoreBounds(positions) {
    const count = positions.length / 3;
    if (count < 20) return this.plotBounds.clone();
    const xs = new Float32Array(count),
      ys = new Float32Array(count);
    for (let i = 0, j = 0; i < positions.length; i += 3, j++) {
      xs[j] = positions[i];
      ys[j] = positions[i + 1];
    }
    xs.sort();
    ys.sort();
    const low = Math.floor((count - 1) * 0.01),
      high = Math.ceil((count - 1) * 0.99);
    const box = new THREE.Box3(
      new THREE.Vector3(xs[low], ys[low], this.plotBounds.min.z),
      new THREE.Vector3(xs[high], ys[high], this.plotBounds.max.z)
    );
    return box.max.x - box.min.x < 0.1 || box.max.y - box.min.y < 0.1
      ? this.plotBounds.clone()
      : box;
  }
  configureTerrain(terrain) {
    this.terrainLocal = null;
    this.terrainMedianLocal = null;
    if (
      terrain?.available &&
      terrain.shape?.length === 2 &&
      terrain.z_values?.length === terrain.shape[0] * terrain.shape[1] &&
      terrain.cell_m > 0
    ) {
      const values = new Float32Array(terrain.z_values.length),
        valid = [];
      for (let i = 0; i < values.length; i++) {
        const z = terrain.z_values[i];
        values[i] = z != null && Number.isFinite(z) ? z - this.origin.z : NaN;
        if (Number.isFinite(values[i])) valid.push(values[i]);
      }
      if (valid.length) {
        valid.sort((a, b) => a - b);
        this.terrainMedianLocal = valid[Math.floor(valid.length / 2)];
        this.terrainLocal = {
          origin: [
            terrain.origin[0] - this.origin.x,
            terrain.origin[1] - this.origin.y,
          ],
          cell_m: terrain.cell_m,
          shape: terrain.shape,
          z_values: values,
        };
      }
    }
    $('height-clip').disabled = !this.terrainLocal;
    $('understory-view').disabled = !this.terrainLocal;
    $('height-clip-title').textContent = this.terrainLocal
      ? 'ตัดภาพเหนือพื้นประมาณการ'
      : 'ตัดภาพส่วนล่างไม่พร้อม';
    $('height-clip-note').textContent = this.terrainLocal
      ? 'ใช้ DTM ประมาณการเพื่อช่วยดูภาพเท่านั้น ไม่เปลี่ยนระดับวัดหรือยืนยัน DBH/POM บริเวณนอกกริดจะคงภาพไว้'
      : 'ไม่มีพื้นดินประมาณการที่พร้อมใช้งาน จะแสดงเต็มความสูงเพื่อไม่ตัดต้นไม้ออกด้วยระดับพื้นดินที่ไม่ทราบ';
  }
  plotHeightAttribute(positions) {
    const values = new Float32Array(positions.length / 3);
    const grid = this.terrainLocal;
    if (!grid) {
      values.fill(-1e20);
      return new THREE.BufferAttribute(values, 1);
    }
    for (let i = 0, j = 0; i < positions.length; i += 3, j++) {
      const ix = Math.floor((positions[i] - grid.origin[0]) / grid.cell_m),
        iy = Math.floor((positions[i + 1] - grid.origin[1]) / grid.cell_m);
      const ground =
        ix >= 0 && iy >= 0 && ix < grid.shape[0] && iy < grid.shape[1]
          ? grid.z_values[ix * grid.shape[1] + iy]
          : NaN;
      values[j] = Number.isFinite(ground) ? positions[i + 2] - ground : -1e20;
    }
    return new THREE.BufferAttribute(values, 1);
  }
  currentFrameBounds() {
    const box = (
      this.frameMode === 'full'
        ? this.plotBounds
        : this.coreBounds || this.plotBounds
    ).clone();
    if (this.terrainLocal && this.clipHeight < this.plotHeightRange - 0.02) {
      box.min.z = this.terrainMedianLocal - 0.75;
      box.max.z = Math.max(
        box.min.z + 0.1,
        this.terrainMedianLocal + this.clipHeight
      );
    }
    return box;
  }
  fitPlot(direction = new THREE.Vector3(1, -1, 0.45)) {
    if (!this.plotBounds) return;
    const box = this.currentFrameBounds();
    const center = box.getCenter(new THREE.Vector3()),
      half = box.getSize(new THREE.Vector3()).multiplyScalar(0.5);
    direction.normalize();
    const forward = direction.clone().negate(),
      right = forward.clone().cross(this.camera.up).normalize(),
      up = right.clone().cross(forward).normalize();
    const tanY = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)),
      tanX = tanY * this.camera.aspect;
    let distance = 1;
    for (const x of [-1, 1])
      for (const y of [-1, 1])
        for (const z of [-1, 1]) {
          const p = new THREE.Vector3(x * half.x, y * half.y, z * half.z),
            depth = p.dot(direction);
          distance = Math.max(
            distance,
            (Math.abs(p.dot(right)) * 1.07) / tanX + depth,
            (Math.abs(p.dot(up)) * 1.07) / tanY + depth
          );
        }
    this.camera.position.copy(center).addScaledVector(direction, distance);
    this.controls.target.copy(center);
    this.controls.update();
    this.updateFrameNote();
  }
  updateFrameNote() {
    const full = this.frameMode === 'full';
    $('plot-frame-note').textContent = full
      ? 'มุมเต็มขอบเขตแปลง'
      : 'มุมพื้นที่หลักจากจุดสำรวจ 1–99% · กดเต็มแปลงเพื่อดูขอบเขตทั้งหมด';
  }
  reset() {
    if (this.mode === 'plot' && this.plotBounds) {
      this.frameMode = 'full';
      this.setClipHeight(this.plotHeightRange);
      this.fitPlot();
    } else {
      this.camera.position.set(3.1, -4.1, 3.0);
      this.controls.target.set(0, 0, 1.1);
      this.controls.update();
    }
  }
  focusCore() {
    if (this.mode !== 'plot') return;
    this.frameMode = 'core';
    this.setClipHeight(this.plotHeightRange);
    this.fitPlot();
  }
  top() {
    if (this.mode === 'plot' && this.plotBounds)
      this.fitPlot(new THREE.Vector3(0, -0.001, 1));
    else {
      this.camera.position.set(0.001, -0.001, 6);
      this.controls.target.set(0, 0, 1.3);
      this.controls.update();
    }
  }
  understory() {
    if (this.mode !== 'plot' || !this.terrainLocal) return;
    this.frameMode = 'understory';
    this.setClipHeight(Math.min(4, this.plotHeightRange));
    this.fitPlot(new THREE.Vector3(1, -1, 0.18));
  }
  setClipHeight(value) {
    if (!this.plotBounds) return;
    const full = !this.terrainLocal || value >= this.plotHeightRange - 0.02;
    this.clipHeight = full ? this.plotHeightRange : value;
    this.clipUniform.value = full ? 1e20 : value;
    $('height-clip').value = full ? this.plotHeightRange : value;
    $('height-clip-value').textContent = full
      ? 'เต็มความสูง'
      : `${format(value, 1)} ม. เหนือพื้นประมาณการ`;
    $('plot-mode-status').textContent = full
      ? 'เต็มความสูง · รวมเรือนยอด'
      : 'ตัดภาพส่วนล่าง · ไม่ใช่ระดับวัด';
  }
  focusMeasurement() {
    if (!this.currentFit) return;
    const { center, radius, normal, u } = this.currentFit;
    const direction = normal.clone().addScaledVector(u, 0.3).normalize();
    this.controls.target.copy(center);
    this.camera.position
      .copy(center)
      .addScaledVector(direction, Math.max(radius * 4, 0.35));
    this.controls.update();
  }
  local(point) {
    return new THREE.Vector3(...point).sub(this.origin);
  }
  points(data, colors, size) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(data, 3)
    );
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    return new THREE.Points(
      geometry,
      new THREE.PointsMaterial({
        size,
        vertexColors: true,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
      })
    );
  }
  loadCloud(data, detail) {
    this.mode = 'tree';
    this.plotBounds = null;
    this.grid.visible = true;
    this.axes.visible = true;
    this.camera.near = 0.01;
    this.camera.far = 500;
    this.controls.maxDistance = 30;
    this.camera.updateProjectionMatrix();
    for (const group of [this.context, this.markers, this.labels, this.details])
      this.clear(group);
    this.markerPoints = null;
    this.markerTreeIDs = [];
    this.origin.set(
      ...(data.origin || detail.plane?.ground_base_xyz || [0, 0, 0])
    );
    const vertices = [],
      colors = [];
    const row = detail.tree;
    const normal = new THREE.Vector3(
      ...(detail.plane?.normal || [0, 0, 1])
    ).normalize();
    const center = new THREE.Vector3(
      ...(detail.plane?.center || [row.x, row.y, row.z_ground + 1.3])
    );
    const colour = new THREE.Color(),
      highlight = new THREE.Color('#62cfa9'),
      ambient = new THREE.Color('#658e8a');
    for (const point of data.points || []) {
      vertices.push(
        point[0] - this.origin.x,
        point[1] - this.origin.y,
        point[2] - this.origin.z
      );
      const delta = new THREE.Vector3(...point).sub(center);
      const radial = delta
        .clone()
        .addScaledVector(normal, -delta.dot(normal))
        .length();
      colour.copy(
        radial < (row.diameter_cm || 30) / 200 + 0.09 ? highlight : ambient
      );
      const modulation =
        0.55 + 0.4 * Math.min(1, Math.max(0, (point[2] - this.origin.z) / 3));
      colour.multiplyScalar(modulation);
      colors.push(colour.r, colour.g, colour.b);
    }
    this.context.add(this.points(vertices, colors, 0.014));
    this.context.visible = this.cloudVisible;
    this.drawMeasurement(detail);
    this.reset();
    $('point-count').textContent =
      `${(data.points?.length || 0).toLocaleString('en-US')} จุด`;
    $('cloud-label').textContent =
      `${shortID(row.tree_id)} · ข้อมูลเฉพาะต้น · หน่วยเมตร`;
  }
  plotColorAttribute(positions, rgb) {
    const colors = new Float32Array(positions.length);
    if (this.colorMode === 'rgb' && rgb && rgb.length === positions.length) {
      for (let i = 0; i < rgb.length; i++) colors[i] = SRGB_TO_LINEAR[rgb[i]];
    } else {
      const minZ = this.plotBounds.min.z,
        range = Math.max(this.plotBounds.max.z - minZ, 0.1);
      for (let i = 0; i < positions.length; i += 3) {
        const h = Math.max(0, Math.min(1, (positions[i + 2] - minZ) / range)),
          t = h < 0.5 ? h * 2 : (h - 0.5) * 2,
          a = h < 0.5 ? [0.18, 0.3, 0.27] : [0.28, 0.66, 0.44],
          b = h < 0.5 ? [0.28, 0.66, 0.44] : [0.91, 0.79, 0.42];
        colors[i] = a[0] + (b[0] - a[0]) * t;
        colors[i + 1] = a[1] + (b[1] - a[1]) * t;
        colors[i + 2] = a[2] + (b[2] - a[2]) * t;
      }
    }
    return new THREE.BufferAttribute(colors, 3);
  }
  plotPoints(positions, detail = false, rgb = null) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', this.plotColorAttribute(positions, rgb));
    geometry.setAttribute('plotHeight', this.plotHeightAttribute(positions));
    const material = new THREE.PointsMaterial({
      size: this.pointSize,
      vertexColors: true,
      sizeAttenuation: false,
      transparent: false,
      depthWrite: true,
    });
    material.onBeforeCompile = shader => {
      shader.uniforms.uClipZ = this.clipUniform;
      shader.vertexShader =
        'attribute float plotHeight;varying float vPlotHeight;\n' +
        shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvPlotHeight=plotHeight;'
      );
      shader.fragmentShader =
        'uniform float uClipZ;varying float vPlotHeight;\n' +
        shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <clipping_planes_fragment>',
        '#include <clipping_planes_fragment>\nif(vPlotHeight>uClipZ || dot(gl_PointCoord-vec2(.5),gl_PointCoord-vec2(.5))>.22)discard;'
      );
    };
    material.customProgramCacheKey = () => 'round-terrain-clipped-plot-v2';
    const points = new THREE.Points(geometry, material);
    points.userData.sourceRGB = rgb;
    return points;
  }
  applyPlotBackground() {
    this.scene.background = new THREE.Color(
      $('cloud-background').value === 'dark' ? '#0e1d24' : '#738185'
    );
    this.scene.fog = null;
  }
  updatePointSize(value) {
    this.pointSize = value;
    for (const group of [this.context, this.details])
      for (const child of group.children)
        if (child.isPoints) child.material.size = value;
  }
  updateColorMode(mode) {
    this.colorMode = mode;
    for (const group of [this.context, this.details])
      for (const child of group.children)
        if (child.isPoints) {
          const attribute = child.geometry.getAttribute('color');
          attribute.array.set(
            this.plotColorAttribute(
              child.geometry.attributes.position.array,
              child.userData.sourceRGB
            ).array
          );
          attribute.needsUpdate = true;
        }
  }
  loadPlot(manifest, positions, trees, rgb = null, terrain = null) {
    this.mode = 'plot';
    this.currentFit = null;
    for (const group of [
      this.context,
      this.measurement,
      this.markers,
      this.labels,
      this.details,
    ])
      this.clear(group);
    this.origin.set(...manifest.origin);
    this.plotBounds = new THREE.Box3(
      this.local(manifest.bounds[0]),
      this.local(manifest.bounds[1])
    );
    this.plotSpan = Math.max(
      this.plotBounds.getSize(new THREE.Vector3()).length(),
      4
    );
    this.camera.near = Math.max(0.05, this.plotSpan / 2000);
    this.camera.far = Math.max(500, this.plotSpan * 10);
    this.controls.maxDistance = Math.max(50, this.plotSpan * 10);
    this.camera.updateProjectionMatrix();
    this.grid.visible = false;
    this.axes.visible = false;
    this.configureTerrain(terrain);
    this.coreBounds = this.calculateCoreBounds(positions);
    this.frameMode = 'core';
    this.applyPlotBackground();
    this.plotHeightRange = Math.max(
      0.2,
      this.plotBounds.max.z - this.plotBounds.min.z
    );
    $('height-clip').max = this.plotHeightRange;
    this.setClipHeight(this.plotHeightRange);
    this.colorMode = $('cloud-color').value;
    this.overviewPositions = positions;
    this.overviewRGB = rgb;
    this.overviewPointObject = this.plotPoints(positions, false, rgb);
    this.context.add(this.overviewPointObject);
    this.context.visible = this.cloudVisible;
    this.details.visible = this.cloudVisible;
    this.overviewPointCount = positions.length / 3;
    this.detailPointCount = 0;
    this.markerTreeIDs = [];
    const markerPositions = [];
    for (const tree of trees) {
      const point = this.local(
        tree.plane?.center || [
          tree.x,
          tree.y,
          tree.z_ground + (tree.measurement_height_m || 1.3),
        ]
      );
      markerPositions.push(point.x, point.y, point.z);
      this.markerTreeIDs.push(tree.tree_id);
      const canvas = document.createElement('canvas');
      canvas.width = 128;
      canvas.height = 34;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = 'rgba(14,35,31,.88)';
      ctx.fillRect(0, 0, 128, 34);
      ctx.strokeStyle = '#699579';
      ctx.strokeRect(0.5, 0.5, 127, 33);
      ctx.fillStyle = '#e3f3d9';
      ctx.textAlign = 'center';
      ctx.font = '20px Segoe UI';
      ctx.fillText(shortID(tree.tree_id), 64, 24);
      const texture = new THREE.CanvasTexture(canvas),
        sprite = new THREE.Sprite(
          new THREE.SpriteMaterial({
            map: texture,
            depthTest: false,
            transparent: true,
          })
        );
      sprite.position
        .copy(point)
        .add(new THREE.Vector3(0, 0, this.plotSpan * 0.009));
      sprite.scale.set(this.plotSpan * 0.045, this.plotSpan * 0.012, 1);
      sprite.renderOrder = 6;
      this.labels.add(sprite);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(markerPositions, 3)
    );
    this.markerPoints = new THREE.Points(
      geometry,
      new THREE.PointsMaterial({
        color: '#f2c774',
        size: 3,
        sizeAttenuation: false,
        depthTest: false,
        transparent: true,
        opacity: 0.85,
      })
    );
    this.markerPoints.renderOrder = 5;
    this.markers.add(this.markerPoints);
    this.labels.visible = this.labelsVisible;
    this.markers.visible = this.labelsVisible;
    this.focusCore();
  }
  loadPlotDetails(buffers, tiles, colorBuffers = []) {
    this.clear(this.details);
    this.detailPointCount = 0;
    const regions = tiles.map(tile => [
      tile.bounds[0][0] - this.origin.x,
      tile.bounds[0][1] - this.origin.y,
      tile.bounds[1][0] - this.origin.x,
      tile.bounds[1][1] - this.origin.y,
    ]);
    const original = this.overviewPositions,
      kept = new Float32Array(original.length),
      keptRGB = this.overviewRGB
        ? new Uint8Array(this.overviewRGB.length)
        : null;
    let length = 0;
    for (let i = 0; i < original.length; i += 3) {
      const x = original[i],
        y = original[i + 1];
      if (
        regions.some(
          b =>
            x >= b[0] - 1e-5 &&
            x <= b[2] + 1e-5 &&
            y >= b[1] - 1e-5 &&
            y <= b[3] + 1e-5
        )
      )
        continue;
      for (let j = 0; j < 3; j++) {
        kept[length] = original[i + j];
        if (keptRGB) keptRGB[length] = this.overviewRGB[i + j];
        length++;
      }
    }
    this.clear(this.context);
    this.overviewPointObject = this.plotPoints(
      kept.subarray(0, length),
      false,
      keptRGB?.subarray(0, length) || null
    );
    this.context.add(this.overviewPointObject);
    this.context.visible = this.cloudVisible;
    this.overviewPointCount = length / 3;
    for (let i = 0; i < buffers.length; i++) {
      this.details.add(
        this.plotPoints(buffers[i], true, colorBuffers[i] || null)
      );
      this.detailPointCount += buffers[i].length / 3;
    }
    this.details.visible = this.cloudVisible;
  }
  drawMeasurement(detail) {
    this.clear(this.measurement);
    this.currentFit = null;
    $('focus-measurement').disabled = true;
    const row = detail.measurement || detail.tree || detail;
    const plane = detail.plane || row.plane;
    if (!plane) return;
    const normal = new THREE.Vector3(...plane.normal).normalize();
    let u, v;
    if (plane.basis_u && plane.basis_v) {
      u = new THREE.Vector3(...plane.basis_u);
      v = new THREE.Vector3(...plane.basis_v);
    } else {
      u = new THREE.Vector3(1, 0, 0).cross(normal).normalize();
      if (u.length() < 0.01) u.set(0, 1, 0).cross(normal).normalize();
      v = normal.clone().cross(u).normalize();
    }
    const center = this.local(plane.center),
      radius = (row.diameter_cm || 30) / 200;
    this.currentFit = {
      center: center.clone(),
      radius,
      normal: normal.clone(),
      u: u.clone(),
    };
    $('focus-measurement').disabled = false;
    const ring = [];
    for (let i = 0; i <= 128; i++) {
      const a = (i / 128) * Math.PI * 2;
      ring.push(
        center
          .clone()
          .addScaledVector(u, radius * Math.cos(a))
          .addScaledVector(v, radius * Math.sin(a))
      );
    }
    const circle = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(ring),
      new THREE.LineBasicMaterial({
        color: '#f6d071',
        depthTest: false,
        transparent: true,
        opacity: 1,
      })
    );
    circle.renderOrder = 3;
    this.measurement.add(circle);
    const width = Math.max(radius * 2.8, 0.4);
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(width, width),
      new THREE.MeshBasicMaterial({
        color: '#e8c568',
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.12,
        depthWrite: false,
      })
    );
    mesh.position.copy(center);
    mesh.quaternion.setFromRotationMatrix(
      new THREE.Matrix4().makeBasis(u, v, normal)
    );
    mesh.name = 'plane';
    mesh.visible = this.planeVisible;
    this.measurement.add(mesh);
    const edge = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints([
        center
          .clone()
          .addScaledVector(u, -width / 2)
          .addScaledVector(v, -width / 2),
        center
          .clone()
          .addScaledVector(u, width / 2)
          .addScaledVector(v, -width / 2),
        center
          .clone()
          .addScaledVector(u, width / 2)
          .addScaledVector(v, width / 2),
        center
          .clone()
          .addScaledVector(u, -width / 2)
          .addScaledVector(v, width / 2),
      ]),
      new THREE.LineBasicMaterial({
        color: '#d2bd7b',
        transparent: true,
        opacity: 0.4,
      })
    );
    edge.name = 'plane';
    edge.visible = this.planeVisible;
    this.measurement.add(edge);
    const xyz = detail.slice_xyz_world || [],
      mask = detail.inlier_mask || [],
      positions = [],
      colors = [];
    const green = new THREE.Color('#55f2b2'),
      red = new THREE.Color('#ff947c');
    for (let i = 0; i < xyz.length; i++) {
      const p = this.local(xyz[i]);
      positions.push(p.x, p.y, p.z);
      const c = mask[i] ? green : red;
      colors.push(c.r, c.g, c.b);
    }
    if (positions.length) {
      const dots = this.points(positions, colors, 0.024);
      dots.renderOrder = 2;
      this.measurement.add(dots);
    }
    const base = plane.ground_base_xyz
      ? this.local(plane.ground_base_xyz)
      : new THREE.Vector3(0, 0, 0);
    const stemNormal = new THREE.Vector3(
      ...(state.detail?.baseline?.plane?.normal || plane.normal)
    ).normalize();
    const axis = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        base.clone().addScaledVector(stemNormal, -0.1),
        base.clone().addScaledVector(stemNormal, 3),
      ]),
      new THREE.LineDashedMaterial({
        color: '#6fa6bd',
        dashSize: 0.045,
        gapSize: 0.045,
        transparent: true,
        opacity: 0.5,
      })
    );
    axis.computeLineDistances();
    this.measurement.add(axis);
  }
  setPlaneVisible(value) {
    this.planeVisible = value;
    this.measurement.children
      .filter(c => c.name === 'plane')
      .forEach(c => (c.visible = value));
  }
  setCloudVisible(value) {
    this.cloudVisible = value;
    this.context.visible = value;
    this.details.visible = value;
  }
  setLabelsVisible(value) {
    this.labelsVisible = value;
    this.labels.visible = value;
    this.markers.visible = value;
  }
}
let viewer;
try {
  viewer = new CloudViewer();
} catch (error) {
  showLoading(false);
  $('cloud-label').textContent = 'ไม่สามารถเริ่ม WebGL ได้';
  status(
    'เบราว์เซอร์นี้ไม่พร้อมแสดง 3D กรุณาเปิด hardware acceleration หรือใช้ Chrome / Edge',
    true
  );
  console.error(error);
}

function renderSummary(detail) {
  const row = detail.measurement || detail.tree || detail;
  $('diameter-value').textContent = format(row.diameter_cm);
  $('circumference-value').textContent = format(
    row.circle_circumference_cm ?? row.circular_circumference_cm
  );
  const pom = row.measurement_type === 'POM';
  $('dbh-label').textContent = pom ? 'POM diameter' : 'DBH ผ่านเกณฑ์';
  $('dbh-value').textContent = pom
    ? `${format(row.pom_diameter_cm ?? row.diameter_cm)} ซม.`
    : row.dbh_cm == null
      ? 'ยังไม่ยืนยัน'
      : `${format(row.dbh_cm)} ซม.`;
  $('height-value').textContent = format(row.measurement_height_m);
  $('coverage-value').textContent = `${format(row.angular_coverage_deg, 1)}°`;
  $('rmse-value').textContent = `${format(row.fit_rmse_cm)} ซม.`;
  $('inlier-value').textContent = (row.inlier_count ?? 0).toLocaleString(
    'en-US'
  );
  $('selected-qc').textContent =
    row.measurement_type === 'POM_REVIEW'
      ? 'POM REVIEW'
      : `QC ${row.qc_grade || 'REVIEW'}`;
  $('result-state').textContent = 'ผลที่เผยแพร่ · อ่านอย่างเดียว';  $('measurement-note').textContent = pom
    ? 'ผล POM แยกจาก DBH · เส้นรอบวงคำนวณจากวงกลม ไม่ใช่เส้นรอบรูปที่ยืนยันด้วยสายวัด'
    : row.measurement_type === 'POM_REVIEW'
      ? 'สงสัยราก / พูพอนรบกวน ควรกำหนดเกณฑ์ POM ก่อนเลือกความสูงวัด'
      : 'ค่าจากเรขาคณิตยังไม่ผ่านการยืนยันกับภาคสนาม · เส้นรอบวง = π × diameter';
}
function renderList() {
  const search = $('tree-search').value.toLowerCase().trim(),
    filter = $('qc-filter').value;
  const rows = state.trees.filter(
    t =>
      (!search || t.tree_id.toLowerCase().includes(search)) &&
      (filter === 'all' ||
        (filter === 'reviewed' && t.revision > 0) ||
        (filter === 'POM_REVIEW' && t.measurement_type === 'POM_REVIEW') ||
        filter === t.qc_grade)
  );
  $('tree-count').textContent = state.trees.length;
  $('tree-list').replaceChildren();
  if (!rows.length)
    $('tree-list').append(make('p', 'empty', 'ไม่พบต้นไม้ตามตัวกรอง'));
  for (const tree of rows) {
    const button = make(
      'button',
      'tree-item' + (tree.tree_id === state.selected ? ' selected' : '')
    );
    button.type = 'button';
    button.dataset.testid = 'tree-item';
    button.dataset.treeId = tree.tree_id;
    button.setAttribute('aria-label', tree.tree_id);
    button.setAttribute(
      'aria-pressed',
      String(tree.tree_id === state.selected)
    );
    const top = make('div', 'tree-item-top');
    top.append(make('span', '', shortID(tree.tree_id)));
    const reviewed = tree.revision > 0;
    const badge = make(
      'span',
      'qc-badge' + (reviewed ? ' reviewed' : tree.qc_grade === 'C' ? ' c' : ''),
      reviewed
        ? 'บันทึกแล้ว'
        : tree.measurement_type === 'POM_REVIEW'
          ? 'POM REVIEW'
          : `QC ${tree.qc_grade}`
    );
    top.append(badge);
    const bottom = make('div', 'tree-item-bottom');
    bottom.append(
      make('span', '', `Ø ${format(tree.diameter_cm, 1)} ซม.`),
      make('span', '', `${format(tree.measurement_height_m)} ม.`)
    );
    button.append(top, bottom);
    button.addEventListener('click', () => selectTree(tree.tree_id));
    $('tree-list').append(button);
  }
  renderMap();
}
function renderMap() {
  const svg = $('tree-map'),
    ns = 'http://www.w3.org/2000/svg';
  svg.replaceChildren();
  if (!state.trees.length) return;
  const xs = state.trees.map(t => t.x),
    ys = state.trees.map(t => t.y),
    minX = Math.min(...xs),
    maxX = Math.max(...xs),
    minY = Math.min(...ys),
    maxY = Math.max(...ys);
  const scale = Math.min(
    210 / Math.max(maxX - minX, 1),
    125 / Math.max(maxY - minY, 1)
  );
  const xOffset = (240 - (maxX - minX) * scale) / 2,
    yOffset = (160 - (maxY - minY) * scale) / 2;
  for (let i = 1; i < 6; i++) {
    const line = document.createElementNS(ns, 'path');
    line.setAttribute('d', `M ${i * 40} 0 V160 M0 ${i * 32} H240`);
    line.setAttribute('stroke', '#203c40');
    line.setAttribute('stroke-width', '.6');
    svg.append(line);
  }
  for (const tree of state.trees) {
    const dot = document.createElementNS(ns, 'circle');
    dot.setAttribute('cx', xOffset + (tree.x - minX) * scale);
    dot.setAttribute('cy', 160 - yOffset - (tree.y - minY) * scale);
    dot.setAttribute('r', tree.tree_id === state.selected ? '4.2' : '2.2');
    dot.setAttribute(
      'fill',
      tree.tree_id === state.selected
        ? '#f6d071'
        : state.plot?.colour_label === 'red'
          ? '#d6a085'
          : state.plot?.colour_label === 'yellow'
            ? '#d8c570'
            : '#6acb9e'
    );
    if (tree.tree_id === state.selected) {
      dot.setAttribute('stroke', '#fff1c3');
      dot.setAttribute('stroke-width', '1');
    }
    const title = document.createElementNS(ns, 'title');
    title.textContent = tree.tree_id;
    dot.append(title);
    dot.addEventListener('click', () => selectTree(tree.tree_id));
    svg.append(dot);
  }
}
function setMode(mode) {
  state.mode = mode;
  document.body.classList.toggle('mode-plot', mode === 'plot');
  $('whole-plot-button').classList.toggle('active', mode === 'plot');
  $('whole-plot-button').setAttribute('aria-pressed', String(mode === 'plot'));
  $('tree-view-button').classList.toggle('active', mode === 'tree');
  $('tree-view-button').setAttribute('aria-pressed', String(mode === 'tree'));
  $('tree-view-button').disabled = !state.trees.length;
  $('inspector-title').textContent =
    mode === 'plot' ? 'ภาพรวมแปลง' : 'ผลแนวตัด · อ่านอย่างเดียว';
  $('plot-mode-status').textContent =
    mode === 'plot' ? 'เต็มความสูง · รวมเรือนยอด' : 'วงวัดและลำต้นเฉพาะต้น';
  $('load-detail').disabled = true;
  $('reset-view').querySelector('span').textContent =
    mode === 'plot' ? 'เต็มแปลง' : 'จัดมุมมอง';
}
async function binaryPoints(url, signal, maxPoints) {
  if (
    typeof url !== 'string' ||
    !url.startsWith(
      `/api/plots/${encodeURIComponent(state.plot.plot_id)}/overview/points/`
    )
  )
    throw new Error('ตำแหน่งข้อมูลภาพรวมไม่ตรงกับแปลงที่เลือก');
  const response = await publicFetch(url, { signal });
  if (!response.ok) throw new Error('ไม่สามารถโหลดจุดภาพรวมได้');
  const expected = Number(response.headers.get('content-length'));
  if (expected > maxPoints * 12)
    throw new Error('ข้อมูลเกินขนาดที่อนุญาตสำหรับมุมมองนี้');
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength % 12 || buffer.byteLength > maxPoints * 12)
    throw new Error('รูปแบบหรือขนาดจุดภาพรวมไม่ถูกต้อง');
  return new Float32Array(buffer);
}
async function binaryColors(url, signal, pointCount) {
  if (
    typeof url !== 'string' ||
    !url.startsWith(
      `/api/plots/${encodeURIComponent(state.plot.plot_id)}/overview/colors/`
    )
  )
    throw new Error('ตำแหน่งสีไม่ตรงกับแปลงที่เลือก');
  const response = await publicFetch(url, { signal });
  if (!response.ok) throw new Error('ไม่สามารถโหลดสีจาก LAS ได้');
  const expected = Number(response.headers.get('content-length'));
  if (expected && expected !== pointCount * 3)
    throw new Error('จำนวนสีไม่ตรงกับจำนวนจุด');
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength !== pointCount * 3)
    throw new Error('ข้อมูลสีไม่ตรงกับตำแหน่งจุด');
  return new Uint8Array(buffer);
}
function scheduleAutoDetail() {
  clearTimeout(autoDetailTimer);
  if (
    state.mode !== 'plot' ||
    !$('auto-detail').checked ||
    !state.overviewManifest ||
    !viewer ||
    viewer.controls.getDistance() > viewer.plotSpan * 0.9
  )
    return;
  autoDetailTimer = setTimeout(() => {
    if (state.mode === 'plot' && $('auto-detail').checked)
      loadNearbyDetail(true);
  }, 650);
}
async function selectPlot(id) {
  state.controller?.abort();
  state.detailController?.abort();
  const generation = ++state.generation;
  const controller = new AbortController();
  state.controller = controller;
  state.plot = state.plots.find(p => p.plot_id === id);
  state.selected = null;
  state.detail = null;
  state.trees = [];
  state.overviewManifest = null;
  clearSelectionDisplay();
  setMode('plot');
  $('tree-search').value = '';
  $('qc-filter').value = 'all';
  $('tree-map').replaceChildren();
  document.body.classList.toggle(
    'plot-red',
    state.plot?.colour_label === 'red'
  );
  document.body.classList.toggle(
    'plot-yellow',
    state.plot?.colour_label === 'yellow'
  );
  $('plot-label').textContent =
    `${state.plot?.label || state.plot?.province || id} · ${densityLabel(state.plot?.density_label)} · ${colourLabel(state.plot?.colour_label)}`;
  $('tree-list').replaceChildren(make('p', 'empty', 'กำลังโหลดต้นไม้…'));
  $('selected-title').textContent = 'ภาพรวมทั้งแปลง';
  showLoading(true, 'กำลังโหลดภาพรวมทั้งแปลง…');
  status('กำลังโหลดแปลงที่เลือก…');
  for (const kind of ['csv', 'xlsx', 'json']) {
    const link = $(`export-${kind}`);
    if (link) {
      link.href = '#';
      link.dataset.plotId = id;
    }
  }
  try {
    const data = await request(apiPath(id, null), {
      signal: controller.signal,
    });
    if (generation !== state.generation) return;
    state.trees = data.trees || [];
    renderList();
    await loadWholePlot();
  } catch (error) {
    if (error.name === 'AbortError') return;
    if (generation !== state.generation) return;
    showLoading(false);
    status(error.message, true);
  }
}
async function loadWholePlot() {
  if (!state.plot) return;
  state.controller?.abort();
  state.detailController?.abort();
  const controller = new AbortController();
  state.controller = controller;
  const generation = ++state.generation;
  state.detail = null;
  state.overviewManifest = null;
  clearSelectionDisplay();
  setMode('plot');
  $('selected-title').textContent =
    `${state.plot.label || state.plot.province} · ภาพรวมทั้งแปลง`;
  $('selected-qc').textContent = 'FULL PLOT';
  $('revision-label').textContent = 'LOD';
  $('plot-source-count').textContent = '—';
  $('plot-render-count').textContent = '—';
  $('plot-tree-count').textContent = state.trees.length.toLocaleString('en-US');
  showLoading(true, 'กำลังโหลดภาพรวมเต็มความสูง…');
  status('กำลังโหลดจุดสำรวจทั้งแปลงแบบลดความหนาแน่น…');
  try {
    const manifest = await request(
      `/api/plots/${encodeURIComponent(state.plot.plot_id)}/overview`,
      { signal: controller.signal }
    );
    if (generation !== state.generation) return;
    $('plot-source-count').textContent = Number(
      manifest.point_count || 0
    ).toLocaleString('en-US');
    if (manifest.status !== 'ready' || !manifest.overview?.url) {
      showLoading(false);
      $('cloud-label').textContent = 'ภาพรวมทั้งแปลงยังเตรียมข้อมูลไม่เสร็จ';
      $('plot-mode-status').textContent = 'กำลังเตรียมข้อมูลทั้งแปลง';
      status(
        'ภาพรวมทั้งแปลงยังไม่พร้อม กด “ทั้งแปลง” เพื่อโหลดอีกครั้ง หรือเลือกตรวจรายต้นระหว่างรอ'
      );
      return;
    }
    const usable = Boolean(
      manifest.overview.colors_url && manifest.color_encoding?.usable !== false
    );
    const [positions, rgb, terrain] = await Promise.all([
      binaryPoints(manifest.overview.url, controller.signal, 1000000),
      usable
        ? binaryColors(
            manifest.overview.colors_url,
            controller.signal,
            manifest.overview.point_count
          )
        : Promise.resolve(null),
      manifest.terrain_url
        ? request(manifest.terrain_url, { signal: controller.signal })
        : Promise.resolve(null),
    ]);
    if (generation !== state.generation || state.mode !== 'plot') return;
    if (rgb && rgb.length !== positions.length)
      throw new Error('ข้อมูลสีไม่ตรงกับตำแหน่งจุด');
    $('cloud-color').querySelector('option[value="rgb"]').disabled = !rgb;
    $('cloud-color').value = rgb ? 'rgb' : 'height';
    state.activeDetailKey = null;
    state.overviewManifest = manifest;
    viewer?.loadPlot(manifest, positions, state.trees, rgb, terrain);
    $('plot-render-count').textContent = (positions.length / 3).toLocaleString(
      'en-US'
    );
    $('point-count').textContent =
      `${(positions.length / 3).toLocaleString('en-US')} จุดภาพรวม`;
    $('cloud-label').textContent = rgb
      ? 'สีจาก LAS · พื้นดินถึงเรือนยอด · หน่วยเมตร'
      : 'ข้อมูลนี้ไม่มีสีที่ใช้งานได้ · แสดงสีตามระดับความสูง';
    $('load-detail').disabled = !viewer || !manifest.tiles?.length;
    showLoading(false);
    status(
      `แสดงภาพรวมเต็มความสูงและตำแหน่ง ${state.trees.length.toLocaleString('en-US')} ต้นที่ระบบตรวจพบ คลิกจุดรหัสหรือเลือกรายการเพื่อตรวจรายต้น`
    );
  } catch (error) {
    if (error.name === 'AbortError') return;
    if (generation !== state.generation) return;
    showLoading(false);
    $('cloud-label').textContent = 'โหลดภาพรวมไม่สำเร็จ';
    status(error.message, true);
  }
}
async function loadNearbyDetail(automatic = false) {
  if (!viewer || state.mode !== 'plot' || !state.overviewManifest) return;
  state.detailController?.abort();
  const controller = new AbortController();
  state.detailController = controller;
  const generation = state.generation,
    manifest = state.overviewManifest;
  const target = viewer.controls.target.clone().add(viewer.origin);
  const detailBudget = Math.min(
    600000,
    1500000 - (manifest.overview.point_count || 1000000)
  );
  let budget = detailBudget;
  const selected = [...manifest.tiles]
    .map(tile => {
      const b = tile.bounds;
      const dx = Math.max(b[0][0] - target.x, 0, target.x - b[1][0]),
        dy = Math.max(b[0][1] - target.y, 0, target.y - b[1][1]);
      return { tile, distance: Math.hypot(dx, dy) };
    })
    .sort((a, b) => a.distance - b.distance)
    .filter(({ tile }) => {
      if (!tile.point_count || tile.point_count > budget) return false;
      budget -= tile.point_count;
      return true;
    })
    .slice(0, 8)
    .map(item => item.tile);
  if (!selected.length) {
    status('ไม่มี tile รายละเอียดที่เหมาะสมในบริเวณนี้');
    return;
  }
  const key = selected.map(tile => tile.url).join('|');
  if (state.activeDetailKey === key) return;
  $('load-detail').disabled = true;
  status(
    `${automatic ? 'เพิ่มรายละเอียดอัตโนมัติ' : 'กำลังโหลดรายละเอียดเฉพาะบริเวณ'} ${selected.length} tiles…`
  );
  try {
    const data = await Promise.all(
      selected.map(async tile => {
        const [positions, colors] = await Promise.all([
          binaryPoints(
            tile.url,
            controller.signal,
            Math.min(detailBudget, tile.point_count)
          ),
          tile.colors_url && manifest.color_encoding?.usable !== false
            ? binaryColors(tile.colors_url, controller.signal, tile.point_count)
            : Promise.resolve(null),
        ]);
        if (colors && colors.length !== positions.length)
          throw new Error('สีรายละเอียดไม่ตรงกับตำแหน่ง');
        return { positions, colors };
      })
    );
    if (generation !== state.generation || state.mode !== 'plot') return;
    const buffers = data.map(d => d.positions),
      colors = data.map(d => d.colors),
      total = buffers.reduce((sum, a) => sum + a.length / 3, 0);
    if (total > detailBudget) throw new Error('รายละเอียดเกินขนาดที่กำหนด');
    viewer.loadPlotDetails(buffers, selected, colors);
    state.activeDetailKey = key;
    $('plot-render-count').textContent =
      viewer.overviewPointCount.toLocaleString('en-US');
    $('point-count').textContent =
      `${viewer.overviewPointCount.toLocaleString('en-US')} ภาพรวม + ${total.toLocaleString('en-US')} รายละเอียด`;
    $('plot-mode-status').textContent = `รายละเอียด ${selected.length} tiles`;
    status(
      'แทนที่จุดภาพรวมด้วยรายละเอียดเฉพาะบริเวณที่มองแล้ว เลื่อนภาพและกดโหลดอีกครั้งเพื่อเปลี่ยนบริเวณ'
    );
  } catch (error) {
    if (error.name !== 'AbortError' && generation === state.generation)
      status(error.message, true);
  } finally {
    if (generation === state.generation && state.mode === 'plot')
      $('load-detail').disabled = false;
  }
}
async function selectTree(id) {
  if (!state.plot) return;
  state.controller?.abort();
  state.detailController?.abort();
  const controller = new AbortController();
  state.controller = controller;
  const generation = ++state.generation;
  state.selected = id;
  state.detail = null;
  clearSelectionDisplay();
  setMode('tree');
  renderList();
  $('selected-title').textContent = id;
  showLoading(true, 'กำลังโหลดข้อมูลเฉพาะต้น…');
  status('กำลังโหลดข้อมูลเฉพาะต้นและวงวัด…');
  try {
    const base = apiPath();
    const [detail, cloud] = await Promise.all([
      request(base, { signal: controller.signal }),
      request(base + '/cloud?radius_m=1.5&max_points=30000', {
        signal: controller.signal,
      }),
    ]);
    if (generation !== state.generation || state.mode !== 'tree') return;
    state.detail = detail;
    renderPublicTreeInfo(detail);
    renderSummary(detail);
    viewer?.loadCloud(cloud, detail);
    $('revision-label').textContent = 'อ่านอย่างเดียว';
    showLoading(false);
    status('ผลแนวตัดที่เผยแพร่สำหรับดูร่วมกัน ไม่มีการแก้ไขข้อมูลหลัก');
  } catch (error) {
    if (error.name === 'AbortError') return;
    if (generation !== state.generation) return;
    showLoading(false);
    status(error.message, true);
  }
}
function renderPublicTreeInfo(detail) {
  const row = detail.tree;
  $('public-measurement-type').textContent = row.measurement_type || '—';
  $('public-height').textContent = `${format(row.measurement_height_m)} ม.`;
  $('public-tilt').textContent = `${format(row.stem_tilt_deg, 1)}°`;
  $('public-qc').textContent = row.qc_grade || 'REVIEW';
  $('public-thickness').textContent =
    `${format(detail.plane?.thickness_m, 2)} ม.`;
}
$('tree-search').addEventListener('input', renderList);
$('qc-filter').addEventListener('change', renderList);
$('plot-select').addEventListener('change', event =>
  selectPlot(event.target.value)
);

$('whole-plot-button').addEventListener('click', () => loadWholePlot());
$('tree-view-button').addEventListener('click', () => {
  const id = state.selected || state.trees[0]?.tree_id;
  if (id) selectTree(id);
});
$('toggle-labels').addEventListener('click', event => {
  if (!viewer) return;
  viewer.setLabelsVisible(!viewer.labelsVisible);
  event.currentTarget.classList.toggle('active', viewer.labelsVisible);
  event.currentTarget.setAttribute(
    'aria-pressed',
    String(viewer.labelsVisible)
  );
});
$('load-detail').addEventListener('click', () => loadNearbyDetail(false));
$('reset-view').addEventListener('click', () => viewer?.reset());
$('top-view').addEventListener('click', () => viewer?.top());
$('focus-measurement').addEventListener('click', () =>
  viewer?.focusMeasurement()
);
$('understory-view').addEventListener('click', () => viewer?.understory());
$('focus-core').addEventListener('click', () => viewer?.focusCore());
$('point-size').addEventListener('input', event => {
  const value = Number(event.target.value);
  $('point-size-value').textContent = `${value.toFixed(1)} px`;
  if (viewer?.mode === 'plot') viewer.updatePointSize(value);
});
$('cloud-color').addEventListener('change', event => {
  if (viewer?.mode === 'plot') viewer.updateColorMode(event.target.value);
});
$('depth-cue').addEventListener('change', event => {
  if (viewer) viewer.depthCue = event.target.checked;
});
$('cloud-background').addEventListener('change', () => {
  if (viewer?.mode === 'plot') viewer.applyPlotBackground();
});
$('height-clip').addEventListener('input', event => {
  if (viewer?.mode === 'plot') viewer.setClipHeight(Number(event.target.value));
});
$('auto-detail').addEventListener('change', () => {
  clearTimeout(autoDetailTimer);
  if ($('auto-detail').checked) scheduleAutoDetail();
});
$('toggle-plane').addEventListener('click', event => {
  if (!viewer) return;
  viewer.setPlaneVisible(!viewer.planeVisible);
  event.currentTarget.classList.toggle('active', viewer.planeVisible);
  event.currentTarget.setAttribute('aria-pressed', String(viewer.planeVisible));
});
$('toggle-cloud').addEventListener('click', event => {
  if (!viewer) return;
  viewer.setCloudVisible(!viewer.cloudVisible);
  event.currentTarget.classList.toggle('active', viewer.cloudVisible);
  event.currentTarget.setAttribute('aria-pressed', String(viewer.cloudVisible));
});

for (const kind of ['csv', 'xlsx', 'json'])
  $('export-' + kind).addEventListener('click', async event => {
    event.preventDefault();
    const plot = state.plot?.plot_id;
    if (!plot) return;
    const generation = state.generation;
    try {
      status('กำลังเตรียมไฟล์ผลที่เผยแพร่…');
      const response = await publicFetch(
        `/api/plots/${encodeURIComponent(plot)}/export?format=${kind}`
      );
      if (!response.ok) throw new Error('ไม่สามารถดาวน์โหลดไฟล์นี้ได้');
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${plot}_public.${kind}`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      if (generation === state.generation)
        status(
          'ดาวน์โหลดเฉพาะผลที่เผยแพร่แล้ว ไม่มีไฟล์ต้นฉบับหรือข้อมูลผู้ตรวจ'
        );
    } catch (error) {
      if (generation === state.generation) status(error.message, true);
    }
  });
setDownloadProgressHandler(({ plot_id, loaded, total }) => {
  if (state.plot?.plot_id !== plot_id) return;
  const value = total
    ? `${Math.min(100, Math.round((loaded / total) * 100))}%`
    : `${format(loaded / 1048576, 1)} MB`;
  status(`กำลังดาวน์โหลดชุดภาพสำรวจ ${value} · โหลดเฉพาะแปลงที่เลือก`);
  if (!$('viewer-loading').hidden)
    $('viewer-loading').querySelector('span').textContent =
      `กำลังโหลดภาพสำรวจ ${value}…`;
});
async function start() {
  try {
    const data = await request('/api/plots');
    state.plots = data.plots || [];
    $('plot-select').replaceChildren();
    for (const plot of state.plots) {
      const option = make(
        'option',
        '',
        `${plot.label || plot.province} · ${densityLabel(plot.density_label)} · ${colourLabel(plot.colour_label)}`
      );
      option.value = plot.plot_id;
      $('plot-select').append(option);
    }
    if (state.plots.length) await selectPlot(state.plots[0].plot_id);
    else {
      showLoading(false);
      status('ไม่พบข้อมูลสำหรับเผยแพร่ กรุณาติดต่อผู้ดูแลชุดข้อมูล', true);
    }
  } catch (error) {
    showLoading(false);
    status(`เชื่อมต่อไม่สำเร็จ: ${error.message}`, true);
  }
}
start();
