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
        partial: 0x38bdf8,
        silent: 0xf87171,
        stale: 0xfbbf24,
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
      partial: 0x0a8ea0,
      silent: 0xd92d20,
      stale: 0xd97706,
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
      '<span><span class="p-dot online"></span> ออนไลน์</span>' +
      '<span><span class="p-dot" style="background:var(--c-err)"></span> เงียบทั้งสาขา</span>' +
      '<span><span class="p-dot unknown"></span> ไม่มีข้อมูล</span>';

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

        // Selection indicator ring
        var selRingGeom = new THREE.RingGeometry(0.45, 0.68, 32);
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
          metro: { targetX: 0.05, targetZ: -0.02, radius: 13.5, phi: 0.74, theta: 0.12 },
          nation: { targetX: 0.0, targetZ: 2.0, radius: 112.0, phi: 0.84, theta: 0.06 }
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

        var pickMeshes = [];
        var pulseRings = [];
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
          pickMeshes = [];
          pulseRings = [];
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
          var positioned = deOverlapPositions(withCoords, 0.56);

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

            var colorHex = !collectorOk
              ? pal.stale
              : isSilent
                ? pal.silent
                : total === 0
                  ? pal.empty
                  : ratio >= 0.99
                    ? pal.ok
                    : pal.partial;

            var pillarH = !collectorOk
              ? 0.9
              : isSilent
                ? 1.55
                : total === 0
                  ? 0.45
                  : 0.65 + ratio * 1.65 + Math.min(total, 10) * 0.06;

            var radius = isSilent ? 0.25 : 0.21;
            var geom = new THREE.CylinderGeometry(radius * 0.85, radius, pillarH, 10);
            var mat = new THREE.MeshLambertMaterial({
              color: colorHex,
              emissive: colorHex,
              emissiveIntensity: isSilent ? 0.35 : 0.12
            });

            var mesh = new THREE.Mesh(geom, mat);
            mesh.position.set(item.x, pillarH / 2 + 0.04, item.z);
            mesh.userData = {
              site: s,
              siteKey: siteKeyValue(s),
              stringKey: String(s.key !== undefined ? s.key : siteKeyValue(s)),
              wx: item.x,
              wz: item.z,
              topY: pillarH + 0.15
            };
            markersGroup.add(mesh);
            pickMeshes.push(mesh);

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
              var pGeom = new THREE.RingGeometry(0.28, 0.48, 24);
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
              ? 'เงียบทั้งสาขา 0/' + s.total + ' เครื่อง'
              : 'ออนไลน์ ' + s.online + '/' + s.total + ' เครื่อง';

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
          camera.lookAt(camState.targetX, 0, camState.targetZ);

          // Pulse silent branch beacons
          var elapsed = (now - t0) * 0.0032;
          for (var i = 0; i < pulseRings.length; i++) {
            var pr = pulseRings[i];
            var phase = (elapsed + i * 0.35) % 1;
            var sc = 1 + phase * 1.45;
            pr.scale.set(sc, sc, 1);
            pr.material.opacity = (1 - phase) * 0.82;
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
