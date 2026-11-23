// IT Maintenance (IT MA) -- 3D Thailand Device Presence Map
// Lazy-loaded when the "เครื่อง" tab opens.
// Loads vendored Three.js (vendor/three@0.160.0/three.min.js) and simplified
// 77-province GeoJSON (data/thailand-provinces.json) only on first mount.
// Zero tile services, zero API keys, zero runtime CDN, full WebGL context cleanup on destroy().

(function () {
  'use strict';

  var THREE_URL = 'vendor/three@0.160.0/three.min.js';
  var GEOJSON_URL = 'data/thailand-provinces.json';

  var threeLoadPromise = null;
  var geoJsonPromise = null;
  var activeInstance = null;

  // Center of Thailand in geographic coordinates -> scene (x, z)
  var LON_CENTER = 100.52;
  var LAT_CENTER = 13.75;
  var SCALE = 11.2; // 1 deg -> ~11.2 world units
  var COS_LAT = Math.cos((LAT_CENTER * Math.PI) / 180);

  function projectLonLat(lon, lat) {
    var x = (lon - LON_CENTER) * SCALE * COS_LAT;
    var z = -(lat - LAT_CENTER) * SCALE;
    return { x: x, z: z };
  }

  function isReducedMotion() {
    return !!(
      window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    );
  }

  function hasWebGL() {
    try {
      var cv = document.createElement('canvas');
      var gl =
        cv.getContext('webgl2') ||
        cv.getContext('webgl') ||
        cv.getContext('experimental-webgl');
      if (!gl) return false;
      var ext = gl.getExtension('WEBGL_lose_context');
      if (ext) ext.loseContext();
      return true;
    } catch (_e) {
      return false;
    }
  }

  function supported() {
    if (isReducedMotion()) return false;
    return hasWebGL();
  }

  function loadThree() {
    if (window.THREE) return Promise.resolve(window.THREE);
    if (threeLoadPromise) return threeLoadPromise;
    threeLoadPromise = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = THREE_URL;
      s.onload = function () {
        if (window.THREE) resolve(window.THREE);
        else reject(new Error('THREE failed to initialize'));
      };
      s.onerror = function () {
        threeLoadPromise = null;
        reject(new Error('Failed to load ' + THREE_URL));
      };
      document.head.appendChild(s);
    });
    return threeLoadPromise;
  }

  function loadGeoJson() {
    if (geoJsonPromise) return geoJsonPromise;
    geoJsonPromise = fetch(GEOJSON_URL)
      .then(function (r) {
        if (!r.ok) throw new Error('GeoJSON HTTP ' + r.status);
        return r.json();
      })
      .catch(function (err) {
        geoJsonPromise = null;
        throw err;
      });
    return geoJsonPromise;
  }

  // Spread points that fall very close together (e.g. 60 sites in Bangkok metro)
  // using an iterative repulsion pass so every branch pillar is distinct and clickable.
  function deOverlapPositions(items, minDist) {
    var n = items.length;
    var pts = items.map(function (it) {
      var p = projectLonLat(Number(it.lng), Number(it.lat));
      return {
        rawX: p.x,
        rawZ: p.z,
        x: p.x,
        z: p.z,
        site: it
      };
    });

    // Deterministic initial tiny jitter for identical coordinates
    for (var i = 0; i < n; i++) {
      var angle = i * 2.399963229728653; // golden angle
      pts[i].x += Math.cos(angle) * 0.015;
      pts[i].z += Math.sin(angle) * 0.015;
    }

    var iters = 36;
    for (var step = 0; step < iters; step++) {
      for (var a = 0; a < n; a++) {
        for (var b = a + 1; b < n; b++) {
          var dx = pts[b].x - pts[a].x;
          var dz = pts[b].z - pts[a].z;
          var dist = Math.sqrt(dx * dx + dz * dz) || 0.0001;
          if (dist < minDist) {
            var push = ((minDist - dist) * 0.52) / dist;
            var px = dx * push;
            var pz = dz * push;
            pts[a].x -= px;
            pts[a].z -= pz;
            pts[b].x += px;
            pts[b].z += pz;
          }
        }
      }
      // Gentle spring pull toward true geographic location
      for (var k = 0; k < n; k++) {
        pts[k].x += (pts[k].rawX - pts[k].x) * 0.08;
        pts[k].z += (pts[k].rawZ - pts[k].z) * 0.08;
      }
    }
    return pts;
  }

  function themePalette() {
    var dark =
      window.matchMedia &&
      window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (dark) {
      return {
        slabTop: 0x16293a,
        metroFill: 0x1e3a50,
        slabSide: 0x0d1a26,
        border: 0x3b8ea5,
        metroBorder: 0x67e8f9,
        grid: 0x182b3c,
        ok: 0x34d399,
        partial: 0xfbbf24,
        silent: 0xf87171,
        stale: 0x64748b,
        hub: 0x67e8f9,
        empty: 0x64748b,
        selectRing: 0xffffff,
        leader: 0x476b87
      };
    }
    return {
      slabTop: 0xd9ebf5,
      metroFill: 0xc2e2f2,
      slabSide: 0xb7d3e6,
      border: 0x0a6c7a,
      metroBorder: 0x07505c,
      grid: 0xc9dfed,
      ok: 0x108548,
      partial: 0xd97706,
      silent: 0xd92d20,
      stale: 0x64748b,
      hub: 0x0a6c7a,
      empty: 0x64748b,
      selectRing: 0x07505c,
      leader: 0x64879e
    };
  }

  function buildProvinceGroup(THREE, geojson, pal) {
    var group = new THREE.Group();
    var slabDepth = 0.72;
    var extrudeSettings = {
      depth: slabDepth,
      bevelEnabled: false,
      curveSegments: 1
    };

    var matMain = new THREE.MeshLambertMaterial({
      color: pal.slabTop
    });
    var matMetro = new THREE.MeshLambertMaterial({
      color: pal.metroFill
    });
    var lineMat = new THREE.LineBasicMaterial({
      color: pal.border,
      transparent: true,
      opacity: 0.55
    });

    var mainShapes = [];
    var metroShapes = [];
    var borderPositions = [];

    function collectRing(ring, isMetro) {
      if (!ring || ring.length < 4) return;
      var shape = new THREE.Shape();
      for (var i = 0; i < ring.length; i++) {
        var pt = projectLonLat(ring[i][0], ring[i][1]);
        var sx = pt.x;
        var sy = -pt.z;
        if (i === 0) shape.moveTo(sx, sy);
        else shape.lineTo(sx, sy);

        if (i > 0) {
          var prev = projectLonLat(ring[i - 1][0], ring[i - 1][1]);
          borderPositions.push(prev.x, 0.04, prev.z, pt.x, 0.04, pt.z);
        }
      }
      if (isMetro) metroShapes.push(shape);
      else mainShapes.push(shape);
    }

    var features = (geojson && geojson.features) || [];
    for (var fIdx = 0; fIdx < features.length; fIdx++) {
      var f = features[fIdx];
      var name = (f.properties && f.properties.name) || '';
      var isMetro = /bangkok|nonthaburi|pathum|samut prakan|samut sakhon|nakhon pathom/i.test(name);
      var g = f.geometry;
      if (!g) continue;
      if (g.type === 'Polygon') {
        collectRing(g.coordinates[0], isMetro);
      } else if (g.type === 'MultiPolygon') {
        for (var p = 0; p < g.coordinates.length; p++) {
          collectRing(g.coordinates[p][0], isMetro);
        }
      }
    }

    if (mainShapes.length) {
      var mainGeom = new THREE.ExtrudeGeometry(mainShapes, extrudeSettings);
      mainGeom.rotateX(-Math.PI / 2);
      mainGeom.translate(0, -slabDepth, 0);
      group.add(new THREE.Mesh(mainGeom, matMain));
    }
    if (metroShapes.length) {
      var metroGeom = new THREE.ExtrudeGeometry(metroShapes, extrudeSettings);
      metroGeom.rotateX(-Math.PI / 2);
      metroGeom.translate(0, -slabDepth + 0.015, 0);
      group.add(new THREE.Mesh(metroGeom, matMetro));
    }
    if (borderPositions.length) {
      var lGeom = new THREE.BufferGeometry();
      lGeom.setAttribute('position', new THREE.Float32BufferAttribute(borderPositions, 3));
      group.add(new THREE.LineSegments(lGeom, lineMat));
    }

    return group;
  }

  // Brand colours from the company's own logos (iCare, Super Drug, Pharmax, head office).
  var BRANDS = {
    icare: { top: '#ffffff', bottom: '#f4862a', ink: '#2a317c' },
    sd: { top: '#ffffff', bottom: '#0c8049', ink: '#0c5a35' },
    pm: { top: '#ffffff', bottom: '#174a8f', ink: '#143a6e' },
    hq: { top: '#ffffff', bottom: '#2b3a8f', ink: '#1e2a6b' },
    other: { top: '#ffffff', bottom: '#5b8aa6', ink: '#22303c' }
  };

  function brandOf(site) {
    var code = String((site && site.code) || '').toUpperCase();
    var b = String((site && site.brand) || '').toUpperCase();
    if (code.indexOf('IC') === 0 || b === 'ICARE') return 'icare';
    if (code.indexOf('SD') === 0 || b === 'SUPER DRUG') return 'sd';
    if (code.indexOf('PM') === 0 || b === 'PHARMAX') return 'pm';
    if (code.indexOf('HQ') === 0 || b === 'HQ') return 'hq';
    return 'other';
  }

  // Original chibi pharmacy staff (about 2.3 heads tall), drawn on canvas. White coat with the
  // brand colour at the collar and shirt, brand hair clip, anime eyes, one pose per status.
  // Frames: w0..w3 (walk), idle, blink, wave. Status also shows as a badge above the head.
  function makeMascotTexture(THREE, status, brand, frame) {
    var B = BRANDS[brand] || BRANDS.other;
    var cv = document.createElement('canvas');
    cv.width = 128;
    cv.height = 208;
    var g = cv.getContext('2d');
    var ink = '#2a2230';
    var skin = '#ffe3cf';
    var hair = '#4a2f27';
    var brandCol = B.bottom;
    var coat = brandCol; // shirt in the brand colour so brands read at a glance
    g.lineCap = 'round';
    g.lineJoin = 'round';

    function line(x0, y0, x1, y1, w, col) {
      g.strokeStyle = col;
      g.lineWidth = w;
      g.beginPath();
      g.moveTo(x0, y0);
      g.lineTo(x1, y1);
      g.stroke();
    }
    function dot(x, y, r, fill, stroke) {
      g.fillStyle = fill;
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
      if (stroke) {
        g.strokeStyle = stroke;
        g.lineWidth = 2.5;
        g.stroke();
      }
    }
    // sleeve with outline, ending in a hand
    function arm(x0, y0, x1, y1) {
      line(x0, y0, x1, y1, 11, ink);
      line(x0, y0, x1, y1, 7, coat);
      dot(x1, y1, 5.5, skin, ink);
    }
    function leg(x0, y0, ang, len) {
      var x1 = x0 + Math.sin(ang) * len;
      var y1 = y0 + Math.cos(ang) * len;
      line(x0, y0, x1, y1, 10, ink);
      line(x0, y0, x1, y1, 6, '#5d6b7a');
      g.fillStyle = B.ink;
      g.beginPath();
      g.ellipse(x1 + 3, y1 + 2, 9, 5.5, 0, 0, Math.PI * 2);
      g.fill();
    }

    // shadow
    g.fillStyle = 'rgba(0,0,0,0.18)';
    g.beginPath();
    g.ellipse(64, 201, 30, 5, 0, 0, Math.PI * 2);
    g.fill();

    var STRIDE = { w0: 0.45, w1: 0, w2: -0.45, w3: 0 };
    var stride = STRIDE[frame] !== undefined ? STRIDE[frame] : 0;
    var seated = status === 'silent';
    var dy = seated ? 18 : 0; // seated: whole upper body sits lower

    // legs
    if (seated) {
      leg(54, 176, 1.35, 24);
      leg(74, 176, 1.35, 24);
    } else {
      leg(58, 160, stride, 30);
      leg(70, 160, -stride, 30);
    }

    // coat body
    g.fillStyle = coat;
    g.strokeStyle = ink;
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(44, 116 + dy);
    g.lineTo(84, 116 + dy);
    g.quadraticCurveTo(92, 140 + dy, 90, 164 + dy);
    g.lineTo(38, 164 + dy);
    g.quadraticCurveTo(36, 140 + dy, 44, 116 + dy);
    g.closePath();
    g.fill();
    g.stroke();
    // white collar
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.moveTo(54, 116 + dy);
    g.lineTo(74, 116 + dy);
    g.lineTo(64, 136 + dy);
    g.closePath();
    g.fill();
    line(64, 136 + dy, 64, 162 + dy, 2, 'rgba(0,0,0,0.35)');
    if (brand === 'hq') {
      g.fillStyle = B.ink;
      g.beginPath();
      g.moveTo(61, 120 + dy); g.lineTo(67, 120 + dy); g.lineTo(69, 140 + dy); g.lineTo(64, 146 + dy); g.lineTo(59, 140 + dy);
      g.closePath();
      g.fill();
    } else if (brand === 'sd') {
      g.fillStyle = '#ffffff';
      g.font = 'bold 14px sans-serif';
      g.textAlign = 'center';
      g.fillText('S', 78, 146 + dy);
      g.textAlign = 'start';
    }

    // back hair (behind the head, gives the side locks)
    dot(64, 70 + dy, 50, hair);
    g.fillStyle = hair;
    g.fillRect(16, 70 + dy, 96, 34);

    // head
    dot(64, 74 + dy, 44, skin, ink);

    // fringe
    g.fillStyle = hair;
    g.beginPath();
    g.moveTo(18, 78 + dy);
    g.arc(64, 72 + dy, 47, Math.PI * 1.02, Math.PI * 1.98);
    g.lineTo(110, 78 + dy);
    g.lineTo(98, 58 + dy);
    g.lineTo(90, 70 + dy);
    g.lineTo(78, 54 + dy);
    g.lineTo(66, 68 + dy);
    g.lineTo(54, 54 + dy);
    g.lineTo(42, 70 + dy);
    g.lineTo(32, 58 + dy);
    g.closePath();
    g.fill();

    // brand hair clip
    if (brand === 'icare') {
      dot(96, 44 + dy, 9, '#ffffff');
      dot(96, 44 + dy, 7, brandCol);
    } else if (brand === 'pm') {
      var leaf = function (cx, cy, rot, col) {
        g.save();
        g.translate(cx, cy);
        g.rotate(rot);
        g.fillStyle = col;
        g.beginPath();
        g.ellipse(0, 0, 4.5, 8, 0, 0, Math.PI * 2);
        g.fill();
        g.restore();
      };
      leaf(88, 42 + dy, -0.7, '#04ae8a');
      leaf(96, 38 + dy, 0, '#f28290');
      leaf(104, 42 + dy, 0.7, '#feb514');
    } else if (brand === 'sd') {
      dot(96, 44 + dy, 6, brandCol, '#ffffff');
    }

    // face
    var ey = 86 + dy;
    function eye(x) {
      g.fillStyle = ink;
      g.beginPath();
      g.ellipse(x, ey, 8.5, 12, 0, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = B.ink === '#22303c' ? '#3b6e8f' : B.ink;
      g.beginPath();
      g.ellipse(x, ey + 3, 6, 7.5, 0, 0, Math.PI * 2);
      g.fill();
      dot(x - 3, ey - 5, 3.2, '#ffffff');
      dot(x + 3, ey + 5, 1.5, '#ffffff');
    }
    function shut(x) {
      g.strokeStyle = ink;
      g.lineWidth = 3;
      g.beginPath();
      g.arc(x, ey + 2, 7, Math.PI * 1.1, Math.PI * 1.9);
      g.stroke();
    }
    function blush() {
      g.fillStyle = 'rgba(255,120,150,0.45)';
      g.beginPath();
      g.ellipse(38, ey + 14, 7, 3.5, 0, 0, Math.PI * 2);
      g.ellipse(90, ey + 14, 7, 3.5, 0, 0, Math.PI * 2);
      g.fill();
    }
    function badge(col) {
      dot(110, 22, 13, col, '#ffffff');
      g.fillStyle = '#ffffff';
      g.font = 'bold 18px sans-serif';
      g.textAlign = 'center';
      g.fillText('!', 110, 28);
      g.textAlign = 'start';
    }
    var blinking = frame === 'blink';

    if (status === 'ok') {
      if (blinking) { shut(48); shut(80); } else { eye(48); eye(80); }
      blush();
      g.fillStyle = '#e8577a';
      g.beginPath();
      g.arc(64, ey + 16, 5, 0, Math.PI);
      g.closePath();
      g.fill();
    } else if (status === 'partial') {
      if (blinking) { shut(48); shut(80); } else { eye(48); eye(80); }
      blush();
      line(38, ey - 17, 54, ey - 14, 2.5, ink);
      line(90, ey - 17, 74, ey - 14, 2.5, ink);
      g.strokeStyle = ink;
      g.lineWidth = 2.5;
      g.beginPath();
      g.moveTo(56, ey + 18); g.quadraticCurveTo(60, ey + 14, 64, ey + 18); g.quadraticCurveTo(68, ey + 22, 72, ey + 18);
      g.stroke();
      g.fillStyle = '#7cc8ff';
      g.beginPath();
      g.moveTo(22, ey - 20);
      g.quadraticCurveTo(29, ey - 8, 22, ey - 4);
      g.quadraticCurveTo(15, ey - 8, 22, ey - 20);
      g.fill();
      badge('#f59e0b');
    } else if (status === 'silent') {
      line(40, ey - 6, 54, ey + 1, 3, ink); line(54, ey + 1, 40, ey + 8, 3, ink);
      line(88, ey - 6, 74, ey + 1, 3, ink); line(74, ey + 1, 88, ey + 8, 3, ink);
      g.fillStyle = ink;
      g.beginPath();
      g.ellipse(64, ey + 20, 6, 5, 0, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#7cc8ff';
      g.fillRect(42, ey + 8, 5, 18);
      g.fillRect(81, ey + 8, 5, 18);
      badge('#d92d20');
    } else {
      shut(48); shut(80);
      line(59, ey + 16, 69, ey + 16, 2.5, ink);
      g.fillStyle = ink;
      g.font = 'bold 16px sans-serif';
      g.fillText('z', 100, 34 + dy);
      g.font = 'bold 12px sans-serif';
      g.fillText('z', 112, 22 + dy);
    }

    // arms last so hands sit in front of the body and face
    if (status === 'silent') {
      arm(44, 124 + dy, 46, ey + 6);
      arm(84, 124 + dy, 82, ey + 6);
    } else if (status === 'partial') {
      arm(44, 124, 34 - stride * 14, 146);
      arm(84, 124, 98, 46);
    } else if (frame === 'wave') {
      arm(44, 124, 34, 146);
      arm(84, 124, 108, 98);
    } else {
      arm(44, 124, 34 - stride * 14, 146);
      arm(84, 124, 94 + stride * 14, 146);
    }

    var tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  function siteKeyValue(site) {
    if (site.site_id !== null && site.site_id !== undefined) return site.site_id;
    return site.code || (site.ifaces && site.ifaces[0]) || '';
  }

  function mount(hostEl, initialData, onSelectSite) {
    destroy();
    if (!hostEl || !supported()) return;

    var disposed = false;
    var canvasHost =
      hostEl.querySelector('.presence-map-canvas-host') || hostEl;

    // Build HUD Controls & Tooltip inside hostEl
    var hud = document.createElement('div');
    hud.className = 'presence-map-hud';

    var camSeg = document.createElement('div');
    camSeg.className = 'seg';
    camSeg.setAttribute('role', 'group');
    camSeg.setAttribute('aria-label', 'มุมกล้องแผนที่');

    var btnMetro = document.createElement('button');
    btnMetro.type = 'button';
    btnMetro.textContent = 'กรุงเทพฯ และปริมณฑล';
    btnMetro.setAttribute('aria-pressed', 'true');

    var btnNation = document.createElement('button');
    btnNation.type = 'button';
    btnNation.textContent = 'ทั้งประเทศ';
    btnNation.setAttribute('aria-pressed', 'false');

    camSeg.appendChild(btnMetro);
    camSeg.appendChild(btnNation);
    hud.appendChild(camSeg);

    var legend = document.createElement('div');
    legend.className = 'presence-map-legend';
    legend.innerHTML =
      // legend dots match the pastel glass bases (GLASS in mount)
      '<span><span class="p-dot" style="background:#8fe3c0"></span> ปกติ</span>' +
      '<span><span class="p-dot" style="background:#ffc98a"></span> ดับบางเครื่อง</span>' +
      '<span><span class="p-dot" style="background:#ff9a9a"></span> ดับทั้งสาขา</span>' +
      '<span><span class="p-dot" style="background:#c6cbe0"></span> ไม่มีข้อมูล</span>' +
      '<span class="legend-note">สีฐาน = สถานะ · สีตัวการ์ตูน = แบรนด์</span>';

    var tooltip = document.createElement('div');
    tooltip.className = 'presence-map-tooltip';
    tooltip.hidden = true;

    hostEl.appendChild(hud);
    hostEl.appendChild(legend);
    hostEl.appendChild(tooltip);

    var instance = {
      destroy: function () {},
      update: function () {},
      orbitStep: function () {}
    };
    activeInstance = instance;

    Promise.all([loadThree(), loadGeoJson()])
      .then(function (loaded) {
        if (disposed || activeInstance !== instance) return;
        var THREE = loaded[0];
        var geojson = loaded[1];
        var pal = themePalette();

        var width = Math.max(280, canvasHost.clientWidth || 640);
        var height = Math.max(320, canvasHost.clientHeight || 420);

        var scene = new THREE.Scene();
        var camera = new THREE.PerspectiveCamera(38, width / height, 0.5, 400);

        var renderer = new THREE.WebGLRenderer({
          antialias: false,
          alpha: true,
          powerPreference: 'high-performance'
        });
        renderer.setPixelRatio(1);
        renderer.setSize(width, height);
        canvasHost.innerHTML = '';
        canvasHost.appendChild(renderer.domElement);

        // Lighting
        var ambLight = new THREE.AmbientLight(0xffffff, 0.85);
        scene.add(ambLight);
        var dirLight = new THREE.DirectionalLight(0xffffff, 0.95);
        dirLight.position.set(18, 42, 24);
        scene.add(dirLight);
        var rimLight = new THREE.DirectionalLight(0x38bdf8, 0.4);
        rimLight.position.set(-22, 25, -18);
        scene.add(rimLight);

        // Subtle base reference ring
        var baseRingGeom = new THREE.RingGeometry(4.2, 4.32, 64);
        baseRingGeom.rotateX(-Math.PI / 2);
        var baseRingMat = new THREE.MeshBasicMaterial({
          color: pal.border,
          transparent: true,
          opacity: 0.16,
          side: THREE.DoubleSide
        });
        var baseRing = new THREE.Mesh(baseRingGeom, baseRingMat);
        baseRing.position.y = -0.02;
        scene.add(baseRing);

        // 77-Province 3D extruded slab
        var provinceGroup = buildProvinceGroup(THREE, geojson, pal);
        scene.add(provinceGroup);

        var markersGroup = new THREE.Group();
        scene.add(markersGroup);
        var mascotGroup = new THREE.Group();
        scene.add(mascotGroup);

        // Selection indicator ring
        var selRingGeom = new THREE.RingGeometry(0.28, 0.4, 32);
        selRingGeom.rotateX(-Math.PI / 2);
        var selRingMat = new THREE.MeshBasicMaterial({
          color: pal.selectRing,
          side: THREE.DoubleSide
        });
        var selRing = new THREE.Mesh(selRingGeom, selRingMat);
        selRing.position.y = 0.08;
        selRing.visible = false;
        scene.add(selRing);

        // Camera spherical orbit state
        var presets = {
          metro: { targetX: 0.05, targetZ: 0.3, radius: 11, phi: 0.62, theta: 0.08 },
          nation: { targetX: 0.0, targetZ: 6.0, radius: 120.0, phi: 0.5, theta: 0.04 }
        };
        var camState = {
          targetX: presets.metro.targetX,
          targetZ: presets.metro.targetZ,
          radius: presets.metro.radius,
          phi: presets.metro.phi,
          theta: presets.metro.theta
        };
        var camGoal = Object.assign({}, camState);

        function setPreset(name) {
          var p = presets[name] || presets.metro;
          camGoal.targetX = p.targetX;
          camGoal.targetZ = p.targetZ;
          camGoal.radius = p.radius;
          camGoal.phi = p.phi;
          camGoal.theta = p.theta;
          btnMetro.setAttribute('aria-pressed', name === 'metro' ? 'true' : 'false');
          btnNation.setAttribute('aria-pressed', name === 'nation' ? 'true' : 'false');
        }

        btnMetro.addEventListener('click', function () {
          setPreset('metro');
        });
        btnNation.addEventListener('click', function () {
          setPreset('nation');
        });

        var GLASS = { ok: 0x8fe3c0, partial: 0xffc98a, silent: 0xff9a9a, none: 0xc6cbe0 };
        var pickMeshes = [];
        var pulseRings = [];
        var mascots = [];
        // Textures built on demand per brand + status, shared by every sprite that needs them.
        // Frames: w0..w3 (walk), idle, blink, wave. Built lazily per brand + status + frame.
        var mascotTex = {};
        function texFor(brand, status, frame) {
          var k = brand + '|' + status + '|' + frame;
          if (!mascotTex[k]) mascotTex[k] = makeMascotTexture(THREE, status, brand, frame);
          return mascotTex[k];
        }
        var camRight = new THREE.Vector3();
        var MASCOT_W = 0.26;
        var WANDER_R = 0.1; // walking radius around the branch point (world units)
        var mascotLast = 0;
        var MASCOT_H = MASCOT_W * 1.625;
        var flowState = null; // { points, particles: [{ curve, t, speed, status }] }
        var HUB_Y = 3.4;
        var currentData = initialData || { collector_ok: true, sites: [] };

        function clearGroup(grp) {
          while (grp.children.length > 0) {
            var ch = grp.children[0];
            grp.remove(ch);
            if (ch.geometry) ch.geometry.dispose();
            if (ch.material) {
              if (Array.isArray(ch.material)) {
                ch.material.forEach(function (m) { m.dispose(); });
              } else {
                ch.material.dispose();
              }
            }
          }
        }

        function rebuildMarkers(data) {
          currentData = data || { collector_ok: true, sites: [] };
          clearGroup(markersGroup);
          while (mascotGroup.children.length) {
            var oldSprite = mascotGroup.children[0];
            mascotGroup.remove(oldSprite);
            oldSprite.material.dispose();
          }
          pickMeshes = [];
          pulseRings = [];
          mascots = [];
          flowState = null;
          selRing.visible = false;

          var collectorOk = Boolean(currentData.collector_ok);
          var withCoords = (currentData.sites || []).filter(function (s) {
            return (
              s.lat !== null &&
              s.lat !== undefined &&
              s.lng !== null &&
              s.lng !== undefined &&
              Number.isFinite(Number(s.lat)) &&
              Number.isFinite(Number(s.lng))
            );
          });

          // Decide initial camera preset: if >50% of mapped sites are in Bangkok metro, start in metro focus
          var positioned = deOverlapPositions(withCoords, 0.6);

          var leaderMat = new THREE.LineBasicMaterial({
            color: pal.leader,
            transparent: true,
            opacity: 0.45
          });

          for (var i = 0; i < positioned.length; i++) {
            var item = positioned[i];
            var s = item.site;
            var total = Number(s.total || 0);
            var online = Number(s.online || 0);
            var ratio = total > 0 ? online / total : 0;
            var isSilent = collectorOk && total > 0 && online === 0;

            var status = !collectorOk || total === 0 ? 'none' : isSilent ? 'silent' : ratio >= 0.99 ? 'ok' : 'partial';
            var colorHex = status === 'none' ? pal.stale : pal[status];

            // Equal low hex tokens: status is colour, not height, so nothing hides behind a tall neighbour.
            var pillarH = 0.1;
            var radius = 0.19;
            var geom = new THREE.CylinderGeometry(radius, radius, pillarH, 6);
            // Pastel "liquid glass" base: soft colour, translucent, glossy, with a light cap on top.
            var glassHex = GLASS[status];
            var mat = new THREE.MeshPhongMaterial({
              color: glassHex,
              emissive: glassHex,
              emissiveIntensity: isSilent ? 0.35 : 0.18,
              specular: 0xffffff,
              shininess: 110,
              transparent: true,
              opacity: 0.82
            });

            var mesh = new THREE.Mesh(geom, mat);
            mesh.position.set(item.x, pillarH / 2 + 0.04, item.z);
            var cap = new THREE.Mesh(
              new THREE.CylinderGeometry(radius * 0.78, radius * 0.9, 0.012, 6),
              new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.42, depthWrite: false })
            );
            cap.position.set(item.x, pillarH + 0.05, item.z);
            markersGroup.add(cap);
            mesh.userData = {
              site: s,
              siteKey: siteKeyValue(s),
              stringKey: String(s.key !== undefined ? s.key : siteKeyValue(s)),
              wx: item.x,
              wz: item.z,
              topY: pillarH + MASCOT_H + 0.05,
              status: status
            };
            markersGroup.add(mesh);
            pickMeshes.push(mesh);

            // Textures are shared across sprites; each sprite owns its material so it can swap walk frames.
            var brand = brandOf(s);
            var sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texFor(brand, status, 'idle'), transparent: true }));
            sprite.center.set(0.5, 0);
            sprite.scale.set(MASCOT_W, MASCOT_H, 1);
            sprite.position.set(item.x, pillarH + 0.02, item.z);
            sprite.userData = mesh.userData;
            sprite.userData.baseY = pillarH + 0.02;
            sprite.userData.phase = i * 0.61;
            sprite.userData.brand = brand;
            sprite.userData.walk = {
              ox: 0, oz: 0, tx: 0, tz: 0,
              wait: (i % 5) * 0.4,
              step: 0,
              blinkAt: 1 + (i % 7) * 0.5,
              blinkUntil: 0,
              waveUntil: 0,
              dir: 1
            };
            mascotGroup.add(sprite);
            pickMeshes.push(sprite);
            mascots.push(sprite);

            // Leader line from true coordinate if shifted by de-crowding
            var shiftSq =
              (item.x - item.rawX) * (item.x - item.rawX) +
              (item.z - item.rawZ) * (item.z - item.rawZ);
            if (shiftSq > 0.02) {
              var lPts = [
                new THREE.Vector3(item.rawX, 0.05, item.rawZ),
                new THREE.Vector3(item.x, 0.05, item.z)
              ];
              var lGeom = new THREE.BufferGeometry().setFromPoints(lPts);
              markersGroup.add(new THREE.Line(lGeom, leaderMat));
            }

            // Pulsing beacon ring under silent branches
            if (isSilent) {
              var pGeom = new THREE.RingGeometry(0.2, 0.3, 24);
              pGeom.rotateX(-Math.PI / 2);
              var pMat = new THREE.MeshBasicMaterial({
                color: pal.silent,
                transparent: true,
                opacity: 0.75,
                side: THREE.DoubleSide
              });
              var pRing = new THREE.Mesh(pGeom, pMat);
              pRing.position.set(item.x, 0.06, item.z);
              markersGroup.add(pRing);
              pulseRings.push(pRing);
            }

            // Selection ring match
            var selKey = currentData.selectedKey;
            if (
              selKey !== null &&
              selKey !== undefined &&
              (String(selKey) === mesh.userData.stringKey ||
                String(selKey) === String(mesh.userData.siteKey))
            ) {
              selRing.position.set(item.x, 0.08, item.z);
              selRing.visible = true;
            }
          }
          buildFlows(collectorOk);
        }

        // Hub = central Sophos. HQ-PDM coords, else PM017 (same building), else a fixed point.
        function hubPosition(sites) {
          var pick = function (code) {
            return (sites || []).find(function (s) {
              return s.code === code && s.lat !== null && s.lat !== undefined && Number.isFinite(Number(s.lat));
            });
          };
          var h = pick('HQ-PDM') || pick('PM017');
          return projectLonLat(h ? Number(h.lng) : 100.5957, h ? Number(h.lat) : 13.7654);
        }

        var hubMesh = null;
        // Hub = a spinning coin with the head-office HL monogram on both faces.
        function coinFaceTexture(mirror) {
          var cv = document.createElement('canvas');
          cv.width = 256;
          cv.height = 256;
          var g = cv.getContext('2d');
          var navy = '#2b3a8f';
          g.fillStyle = '#ffffff';
          g.beginPath();
          g.arc(128, 128, 126, 0, Math.PI * 2);
          g.fill();
          g.strokeStyle = navy;
          g.lineWidth = 14;
          g.beginPath();
          g.arc(128, 128, 112, 0, Math.PI * 2);
          g.stroke();
          if (mirror) {
            g.translate(256, 0);
            g.scale(-1, 1);
          }
          g.fillStyle = navy;
          g.font = 'bold 120px sans-serif';
          g.textAlign = 'center';
          g.textBaseline = 'middle';
          g.fillText('HL', 128, 136);
          var t = new THREE.CanvasTexture(cv);
          t.colorSpace = THREE.SRGBColorSpace;
          // cylinder cap UVs run sideways once the coin is stood up
          t.center.set(0.5, 0.5);
          t.rotation = Math.PI / 2;
          return t;
        }
        var hubGeom = new THREE.CylinderGeometry(0.38, 0.38, 0.07, 48);
        hubGeom.rotateX(Math.PI / 2); // stand the coin up; faces look along Z
        var hubFront = coinFaceTexture(false);
        var hubBack = coinFaceTexture(false); // the back cap UVs already mirror it back to readable
        var hubMat = [
          new THREE.MeshLambertMaterial({ color: 0xd4af37, emissive: 0x6b5410, emissiveIntensity: 0.4 }), // rim
          new THREE.MeshBasicMaterial({ map: hubFront }),
          new THREE.MeshBasicMaterial({ map: hubBack })
        ];

        // One arc per mapped branch into the hub; light particles travel along healthy links only.
        function buildFlows(collectorOk) {
          var hp = hubPosition(currentData.sites);
          if (!hubMesh) {
            hubMesh = new THREE.Mesh(hubGeom, hubMat);
            scene.add(hubMesh);
          }
          hubMesh.position.set(hp.x, HUB_Y, hp.z);
          var hub = new THREE.Vector3(hp.x, HUB_Y, hp.z);

          var particles = [];
          var mats = {};
          function lineMat(status) {
            if (mats[status]) return mats[status];
            var m;
            if (status === 'silent') {
              m = new THREE.LineDashedMaterial({ color: pal.silent, dashSize: 0.18, gapSize: 0.12, transparent: true, opacity: 0.95 });
            } else {
              var op = status === 'ok' ? 0.3 : status === 'partial' ? 0.6 : 0.22;
              m = new THREE.LineBasicMaterial({ color: status === 'none' ? pal.stale : pal[status], transparent: true, opacity: op });
            }
            mats[status] = m;
            return m;
          }

          for (var i = 0; i < pickMeshes.length; i++) {
            var u = pickMeshes[i].userData;
            var start = new THREE.Vector3(u.wx, u.topY - 0.1, u.wz);
            var dist = start.distanceTo(hub);
            if (dist < 0.3) continue;
            var mid = start.clone().lerp(hub, 0.5);
            mid.y += Math.min(4, 0.7 + dist * 0.3);
            var curve = new THREE.QuadraticBezierCurve3(start, mid, hub);
            var g = new THREE.BufferGeometry().setFromPoints(curve.getPoints(24));
            var line = new THREE.Line(g, lineMat(u.status));
            if (u.status === 'silent') line.computeLineDistances();
            markersGroup.add(line);

            if (!collectorOk || (u.status !== 'ok' && u.status !== 'partial')) continue;
            var online = Number(u.site.online || 0);
            var n = Math.max(1, Math.min(3, Math.ceil(online / 4)));
            var speed = (u.status === 'ok' ? 0.42 : 0.18) / Math.max(1, dist * 0.12);
            for (var k = 0; k < n; k++) {
              particles.push({ curve: curve, t: (k / n + i * 0.137) % 1, speed: speed, status: u.status });
            }
          }

          if (!particles.length) return;
          var pos = new Float32Array(particles.length * 3);
          var col = new Float32Array(particles.length * 3);
          var cOk = new THREE.Color(pal.ok);
          var cPart = new THREE.Color(pal.partial);
          particles.forEach(function (p, idx) {
            var c = p.status === 'ok' ? cOk : cPart;
            col[idx * 3] = c.r;
            col[idx * 3 + 1] = c.g;
            col[idx * 3 + 2] = c.b;
          });
          var pg = new THREE.BufferGeometry();
          pg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
          pg.setAttribute('color', new THREE.BufferAttribute(col, 3));
          var pm = new THREE.PointsMaterial({
            size: 7,
            sizeAttenuation: false,
            vertexColors: true,
            transparent: true,
            opacity: 0.95,
            depthWrite: false
          });
          var points = new THREE.Points(pg, pm);
          markersGroup.add(points);
          flowState = { points: points, particles: particles, tmp: new THREE.Vector3(), last: 0 };
        }

        rebuildMarkers(initialData);

        // Pointer interaction (Orbit / Pan / Tap to select / Hover tooltip)
        var raycaster = new THREE.Raycaster();
        var pointer = new THREE.Vector2();
        var isDragging = false;
        var dragMoved = false;
        var downX = 0;
        var downY = 0;
        var lastX = 0;
        var lastY = 0;
        var dragButton = 0;

        function pickAtClient(clientX, clientY) {
          var rect = renderer.domElement.getBoundingClientRect();
          if (!rect.width || !rect.height) return null;
          pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
          pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
          raycaster.setFromCamera(pointer, camera);
          var hits = raycaster.intersectObjects(pickMeshes, false);
          return hits.length > 0 ? hits[0].object : null;
        }

        function showTooltipForMesh(mesh) {
          if (!mesh || !mesh.userData || !mesh.userData.site) {
            tooltip.hidden = true;
            return;
          }
          var s = mesh.userData.site;
          var v = new THREE.Vector3(mesh.userData.wx, mesh.userData.topY, mesh.userData.wz);
          v.project(camera);
          var rect = renderer.domElement.getBoundingClientRect();
          var sx = (v.x * 0.5 + 0.5) * rect.width;
          var sy = (-v.y * 0.5 + 0.5) * rect.height;

          var stText = !currentData.collector_ok
            ? 'ไม่มีข้อมูล (' + s.total + ' เครื่อง)'
            : s.total > 0 && s.online === 0
              ? 'ดับทั้งสาขา 0/' + s.total + ' เครื่อง'
              : s.online < s.total
                ? 'ดับ ' + (s.total - s.online) + ' จาก ' + s.total + ' เครื่อง'
                : 'ปกติ ' + s.online + '/' + s.total + ' เครื่อง';

          // Build with textContent: site names and Sophos iface names are untrusted text.
          tooltip.textContent = '';
          var tipCode = document.createElement('strong');
          tipCode.textContent = s.code || '';
          var tipStatus = document.createElement('span');
          tipStatus.textContent = stText;
          tooltip.appendChild(tipCode);
          tooltip.appendChild(document.createTextNode(' · ' + (s.name || '')));
          tooltip.appendChild(document.createElement('br'));
          tooltip.appendChild(tipStatus);
          tooltip.style.left = Math.max(70, Math.min(rect.width - 70, sx)) + 'px';
          tooltip.style.top = Math.max(44, Math.min(rect.height - 20, sy)) + 'px';
          tooltip.hidden = false;
        }

        function selectMesh(mesh) {
          if (!mesh || !mesh.userData) return;
          selRing.position.set(mesh.userData.wx, 0.08, mesh.userData.wz);
          selRing.visible = true;
          camGoal.targetX = mesh.userData.wx;
          camGoal.targetZ = mesh.userData.wz;
          camGoal.radius = Math.min(camGoal.radius, 18.0);
          showTooltipForMesh(mesh);
          if (typeof onSelectSite === 'function') {
            onSelectSite(mesh.userData.siteKey);
          }
        }

        var domEl = renderer.domElement;
        domEl.style.touchAction = 'none';

        domEl.addEventListener('pointerdown', function (e) {
          isDragging = true;
          dragMoved = false;
          downX = lastX = e.clientX;
          downY = lastY = e.clientY;
          dragButton = e.button || 0;
        });

        domEl.addEventListener('pointermove', function (e) {
          if (isDragging) {
            var dx = e.clientX - lastX;
            var dy = e.clientY - lastY;
            lastX = e.clientX;
            lastY = e.clientY;
            if (Math.abs(e.clientX - downX) + Math.abs(e.clientY - downY) > 5) {
              dragMoved = true;
            }
            if (dragButton === 2 || e.shiftKey) {
              var panFactor = camGoal.radius * 0.0018;
              camGoal.targetX -= dx * panFactor;
              camGoal.targetZ -= dy * panFactor;
            } else {
              camGoal.theta -= dx * 0.0075;
              camGoal.phi = Math.max(0.28, Math.min(1.36, camGoal.phi - dy * 0.0065));
            }
            tooltip.hidden = true;
          } else {
            var hit = pickAtClient(e.clientX, e.clientY);
            domEl.style.cursor = hit ? 'pointer' : 'grab';
            showTooltipForMesh(hit);
          }
        });

        window.addEventListener('pointerup', onPointerUp);
        function onPointerUp(e) {
          if (!isDragging) return;
          isDragging = false;
          if (!dragMoved && e.target === domEl) {
            var hit = pickAtClient(e.clientX, e.clientY);
            if (hit) selectMesh(hit);
            else tooltip.hidden = true;
          }
        }

        domEl.addEventListener(
          'wheel',
          function (e) {
            e.preventDefault();
            var factor = e.deltaY > 0 ? 1.12 : 0.89;
            camGoal.radius = Math.max(5.5, Math.min(150.0, camGoal.radius * factor));
          },
          { passive: false }
        );

        domEl.addEventListener('contextmenu', function (e) {
          e.preventDefault();
        });

        function onResize() {
          if (disposed) return;
          var nw = Math.max(280, canvasHost.clientWidth || 640);
          var nh = Math.max(320, canvasHost.clientHeight || 420);
          camera.aspect = nw / nh;
          camera.updateProjectionMatrix();
          renderer.setSize(nw, nh);
        }
        window.addEventListener('resize', onResize);

        // Expose programmatic selection & orbit helper for automated testing and external triggers
        instance.selectSiteByKey = function (siteKey) {
          var target = pickMeshes.find(function (m) {
            return (
              String(m.userData.siteKey) === String(siteKey) ||
              String(m.userData.stringKey) === String(siteKey)
            );
          });
          if (target) {
            selectMesh(target);
            return true;
          }
          return false;
        };

        instance.setOrbitAngle = function (thetaDelta) {
          camGoal.theta += thetaDelta;
        };

        instance.getMarkerScreenCoords = function () {
          var rect = renderer.domElement.getBoundingClientRect();
          return pickMeshes.map(function (m) {
            var v = new THREE.Vector3(m.userData.wx, m.userData.topY * 0.5, m.userData.wz);
            v.project(camera);
            return {
              siteKey: m.userData.siteKey,
              code: m.userData.site.code,
              x: rect.left + (v.x * 0.5 + 0.5) * rect.width,
              y: rect.top + (-v.y * 0.5 + 0.5) * rect.height
            };
          });
        };

        var rafId = 0;
        var t0 = performance.now();

        function animate(now) {
          if (disposed) return;
          rafId = requestAnimationFrame(animate);

          // Smooth damping
          camState.targetX += (camGoal.targetX - camState.targetX) * 0.14;
          camState.targetZ += (camGoal.targetZ - camState.targetZ) * 0.14;
          camState.radius += (camGoal.radius - camState.radius) * 0.14;
          camState.phi += (camGoal.phi - camState.phi) * 0.14;
          camState.theta += (camGoal.theta - camState.theta) * 0.14;

          var sinPhi = Math.sin(camState.phi);
          var cosPhi = Math.cos(camState.phi);
          var sinTheta = Math.sin(camState.theta);
          var cosTheta = Math.cos(camState.theta);

          camera.position.set(
            camState.targetX + camState.radius * sinPhi * sinTheta,
            camState.radius * cosPhi,
            camState.targetZ + camState.radius * sinPhi * cosTheta
          );
          camera.lookAt(camState.targetX, 1.1, camState.targetZ);

          // Pulse silent branch beacons
          var elapsed = (now - t0) * 0.0032;
          for (var i = 0; i < pulseRings.length; i++) {
            var pr = pulseRings[i];
            var phase = (elapsed + i * 0.35) % 1;
            var sc = 1 + phase * 1.45;
            pr.scale.set(sc, sc, 1);
            pr.material.opacity = (1 - phase) * 0.82;
          }

          if (hubMesh) hubMesh.rotation.y = elapsed * 0.55;
          var ts = now / 1000;
          camRight.setFromMatrixColumn(camera.matrixWorld, 0);
          var mdt = mascotLast ? Math.min(0.05, (now - mascotLast) / 1000) : 0;
          mascotLast = now;
          for (var mi = 0; mi < mascots.length; mi++) {
            var ms = mascots[mi];
            var md = ms.userData;
            var w = md.walk;
            if (md.status === 'ok' || md.status === 'partial') {
              var spd = md.status === 'ok' ? 0.16 : 0.07;
              var dx = w.tx - w.ox;
              var dz = w.tz - w.oz;
              var d = Math.sqrt(dx * dx + dz * dz);
              var moving = false;
              if (w.wait > 0) {
                w.wait -= mdt;
              } else if (d < 0.01) {
                // arrived: rest, then pick a new spot within the branch's small yard
                w.wait = (md.status === 'ok' ? 0.6 : 1.8) + Math.random() * 1.6;
                if (md.status === 'ok' && Math.random() < 0.3) w.waveUntil = ts + 1.2;
                var ang = Math.random() * Math.PI * 2;
                var rad = 0.05 + Math.random() * WANDER_R;
                w.tx = Math.cos(ang) * rad;
                w.tz = Math.sin(ang) * rad;
              } else {
                var stepLen = Math.min(d, spd * mdt);
                // face the way we walk, as seen on screen
                var sx = dx * camRight.x + dz * camRight.z;
                if (Math.abs(sx) > 1e-4) w.dir = sx > 0 ? 1 : -1;
                w.ox += (dx / d) * stepLen;
                w.oz += (dz / d) * stepLen;
                moving = true;
              }
              w.step += moving ? mdt * (md.status === 'ok' ? 7 : 4) : 0;
              if (ts > w.blinkAt) {
                w.blinkUntil = ts + 0.14;
                w.blinkAt = ts + 2.5 + Math.random() * 3;
              }
              var fname = moving
                ? 'w' + (Math.floor(w.step) % 4)
                : ts < w.waveUntil ? (Math.floor(ts * 4) % 2 ? 'wave' : 'idle')
                : ts < w.blinkUntil ? 'blink' : 'idle';
              var frame = texFor(md.brand, md.status, fname);
              if (ms.material.map !== frame) ms.material.map = frame;
              ms.scale.x = MASCOT_W * w.dir;
              ms.position.x = md.wx + w.ox;
              ms.position.z = md.wz + w.oz;
              var bob = moving ? Math.abs(Math.sin(w.step * Math.PI / 2)) * 0.025 : 0;
              if (md.status === 'partial' && moving) bob *= Math.floor(w.step) % 4 < 2 ? 1.8 : 0.3; // limp
              ms.position.y = md.baseY + bob;
              if (md.status === 'partial' && !moving) ms.scale.x = MASCOT_W * (Math.floor(ts / 0.9 + md.phase) % 2 ? 1 : -1); // look around
            } else if (md.status === 'silent') {
              ms.position.y = md.baseY;
              ms.position.x = md.wx + Math.sin(ts * 22 + md.phase) * 0.018;
            } else {
              ms.position.y = md.baseY;
              ms.scale.y = MASCOT_H * (1 + Math.sin(ts * 1.3 + md.phase) * 0.04);
            }
          }
          if (flowState) {
            var dt = flowState.last ? Math.min(0.05, (now - flowState.last) / 1000) : 0;
            flowState.last = now;
            var arr = flowState.points.geometry.attributes.position.array;
            for (var f = 0; f < flowState.particles.length; f++) {
              var fp = flowState.particles[f];
              fp.t = (fp.t + fp.speed * dt) % 1;
              fp.curve.getPoint(fp.t, flowState.tmp);
              arr[f * 3] = flowState.tmp.x;
              arr[f * 3 + 1] = flowState.tmp.y;
              arr[f * 3 + 2] = flowState.tmp.z;
            }
            flowState.points.geometry.attributes.position.needsUpdate = true;
          }

          renderer.render(scene, camera);
        }
        rafId = requestAnimationFrame(animate);

        instance.update = function (nextData) {
          if (disposed) return;
          rebuildMarkers(nextData);
        };

        instance.destroy = function () {
          if (disposed) return;
          disposed = true;
          cancelAnimationFrame(rafId);
          window.removeEventListener('pointerup', onPointerUp);
          window.removeEventListener('resize', onResize);
          clearGroup(markersGroup);
          clearGroup(provinceGroup);
          if (baseRingGeom) baseRingGeom.dispose();
          if (baseRingMat) baseRingMat.dispose();
          if (selRingGeom) selRingGeom.dispose();
          if (selRingMat) selRingMat.dispose();
          hubGeom.dispose();
          hubMat.forEach(function (m) { m.dispose(); });
          hubFront.dispose();
          hubBack.dispose();
          mascots.forEach(function (m) { m.material.dispose(); });
          Object.keys(mascotTex).forEach(function (k) { mascotTex[k].dispose(); });
          try {
            renderer.dispose();
            renderer.forceContextLoss();
          } catch (_e) {}
          if (renderer.domElement && renderer.domElement.parentNode) {
            renderer.domElement.parentNode.removeChild(renderer.domElement);
          }
          if (hud.parentNode) hud.parentNode.removeChild(hud);
          if (legend.parentNode) legend.parentNode.removeChild(legend);
          if (tooltip.parentNode) tooltip.parentNode.removeChild(tooltip);
        };
      })
      .catch(function () {
        // Fallback handled if assets fail to load
      });
  }

  function update(data) {
    if (activeInstance && typeof activeInstance.update === 'function') {
      activeInstance.update(data);
    }
  }

  function destroy() {
    if (activeInstance) {
      var inst = activeInstance;
      activeInstance = null;
      if (typeof inst.destroy === 'function') inst.destroy();
    }
  }

  window.ItmPresenceMap = {
    mount: mount,
    update: update,
    destroy: destroy,
    supported: supported,
    _getActive: function () {
      return activeInstance;
    }
  };
})();
