document.addEventListener('DOMContentLoaded', () => {

  // ========================
  // 1. STATE
  // ========================
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const BRUSH_SIZE_PX = 18;
  const MIN_POINT_DISTANCE_PX = 2.5;

  let currentColor = '#d62828'; // Default: red
  let currentSVG = 'woody_clean.svg'; // Default character
  let activeStroke = null;
  let clipCounter = 0;
  let strokeCounter = 0;

  const urlParams = new URLSearchParams(window.location.search);
  const tabletId = Number.parseInt(urlParams.get('tabletId'), 10) || 1;
  const room = urlParams.get('room') || 'default';
  const channelKey = `toystory-sync-${room}`;
  const sourceId = `tablet-${tabletId}-${Math.random().toString(36).slice(2, 8)}`;

  const socket = typeof io !== 'undefined' ? io() : null;
  const syncChannel = !socket && typeof BroadcastChannel !== 'undefined'
    ? new BroadcastChannel(channelKey)
    : null;

  function publishEvent(type, payload) {
    if (socket && socket.connected) {
      socket.emit(type, payload);
      return;
    }

    const message = {
      type,
      payload,
      sourceId,
      timestamp: Date.now()
    };

    if (syncChannel) {
      syncChannel.postMessage(message);
    }

    // `storage` event allows fallback sync between tabs/windows in the same browser profile.
    try {
      localStorage.setItem(channelKey, JSON.stringify(message));
    } catch (err) {
      console.warn('No se pudo publicar evento de sincronización local:', err);
    }
  }

  // Cuando el socket se conecta, avisar al videowall qué personaje tiene esta tablet
  if (socket) {
    socket.on('connect', () => {
      console.log(`[Tablet ${tabletId}] Socket conectado. Anunciando SVG: ${currentSVG}`);
      publishEvent('cambiar_personaje', {
        tabletId,
        svgFile: currentSVG
      });
    });
  }

  window.addEventListener('pointerup', finishDrawing);
  window.addEventListener('pointercancel', finishDrawing);

  // ========================
  // 2. DOM ELEMENTS
  // ========================
  const svgWrapper = document.getElementById('svg-wrapper');
  const paletteButtons = document.querySelectorAll('.color-btn');
  const charButtons = document.querySelectorAll('.char-btn');

  // ========================
  // 3. LOAD SVG
  // ========================
  function loadSVG(filename) {
    activeStroke = null;
    currentSVG = filename;

    svgWrapper.innerHTML = '<div class="loading-msg">Cargando...</div>';

    fetch(filename)
      .then(res => {
        if (!res.ok) throw new Error(`HTTP error ${res.status}`);
        return res.text();
      })
      .then(svgText => {
        // Inject SVG inline so CSS and events can access its elements
        svgWrapper.innerHTML = svgText;

        const svg = svgWrapper.querySelector('svg');
        if (!svg) return;

        // Remove any inline width/height from the SVG root so CSS controls it
        svg.removeAttribute('width');
        svg.removeAttribute('height');
        svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

        // Mark drawable shapes so each pointer gesture can lock onto one element.
        setupColoringPaths(svg);

        // Solo emitir si el socket ya está conectado; si no, el evento 'connect'
        // lo hará automáticamente cuando el socket se establezca
        publishEvent('cambiar_personaje', { tabletId, svgFile: currentSVG });
      })
      .catch(err => {
        console.error('Error loading SVG:', err);
        svgWrapper.innerHTML = '<div class="loading-msg">Error al cargar el personaje.</div>';
      });
  }

  // ========================
  // 4. DRAWING MOTOR (FREE DRAW INSIDE ONE SVG ELEMENT)
  // ========================
  
  svgWrapper.addEventListener('pointerdown', startDrawing);
  svgWrapper.addEventListener('pointermove', continueDrawing);

  function startDrawing(e) {
    const svg = svgWrapper.querySelector('svg');
    if (!svg) return;

    const target = getColorableTargetAtPoint(e.clientX, e.clientY);
    if (!target || !svg.contains(target)) return;

    e.preventDefault();
    e.stopPropagation();

    const parent = getDrawableParent(target);
    const point = clientPointToLocal(parent, e.clientX, e.clientY);
    if (!point) return;

    const clipId = ensureClipPathForTarget(svg, target);
    const pathEl = createStrokePath(parent, clipId, currentColor);

    activeStroke = {
      pointerId: e.pointerId,
      svg,
      parent,
      target,
      pathEl,
      color: currentColor,
      points: [point],
      minDistance: screenDistanceToLocal(parent, MIN_POINT_DISTANCE_PX)
    };

    renderStroke(activeStroke);

    try {
      svgWrapper.setPointerCapture(e.pointerId);
    } catch (err) {
      // Some embedded webviews do not allow pointer capture; drawing still works.
    }
  }

  function continueDrawing(e) {
    if (!activeStroke || e.pointerId !== activeStroke.pointerId) return;

    e.preventDefault();
    e.stopPropagation();

    const point = clientPointToLocal(activeStroke.parent, e.clientX, e.clientY);
    if (!point) return;

    addPointToStroke(activeStroke, point);
  }

  function finishDrawing(e) {
    if (!activeStroke) return;
    if (e && e.pointerId !== undefined && e.pointerId !== activeStroke.pointerId) return;

    if (e && e.clientX !== undefined && e.clientY !== undefined) {
      const point = clientPointToLocal(activeStroke.parent, e.clientX, e.clientY);
      if (point) addPointToStroke(activeStroke, point);
    }

    const finishedStroke = activeStroke;
    activeStroke = null;

    try {
      svgWrapper.releasePointerCapture(finishedStroke.pointerId);
    } catch (err) {
      // Pointer capture may not have been granted in every browser/webview.
    }

    publishEvent('dibujar_trazo', {
      tabletId,
      svgFile: currentSVG,
      elementId: finishedStroke.target.id,
      color: finishedStroke.color,
      brushSizePx: BRUSH_SIZE_PX,
      points: compactPoints(finishedStroke.points)
    });
  }

  function getColorableTargetAtPoint(clientX, clientY) {
    const target = document.elementFromPoint(clientX, clientY);
    if (!target || !svgWrapper.contains(target) || !(target instanceof Element)) {
      return null;
    }

    return target.closest('.colorable');
  }

  function getDrawableParent(target) {
    return target.parentNode instanceof SVGElement ? target.parentNode : target.ownerSVGElement;
  }

  function clientPointToLocal(parent, clientX, clientY) {
    const svg = parent.ownerSVGElement || parent;
    const matrix = parent.getScreenCTM();
    if (!svg || !matrix) return null;

    const point = svg.createSVGPoint();
    point.x = clientX;
    point.y = clientY;

    const localPoint = point.matrixTransform(matrix.inverse());
    return { x: localPoint.x, y: localPoint.y };
  }

  function screenDistanceToLocal(parent, px) {
    const matrix = parent.getScreenCTM();
    if (!matrix) return px;

    const scale = Math.sqrt(Math.abs(matrix.a * matrix.d - matrix.b * matrix.c));
    return scale ? px / scale : px;
  }

  function ensureDefs(svg) {
    let defs = Array.from(svg.children).find(child => child.classList?.contains('drawing-defs'));
    if (!defs) {
      defs = document.createElementNS(SVG_NS, 'defs');
      defs.classList.add('drawing-defs');
      svg.insertBefore(defs, svg.firstChild);
    }

    return defs;
  }

  function ensureClipPathForTarget(svg, target) {
    if (target.dataset.clipPathId) return target.dataset.clipPathId;

    const clipId = `clip-${sourceId}-${++clipCounter}`;
    const clipPath = document.createElementNS(SVG_NS, 'clipPath');
    const clipShape = target.cloneNode(false);

    clipPath.id = clipId;
    clipPath.setAttribute('clipPathUnits', 'userSpaceOnUse');

    clipShape.removeAttribute('id');
    clipShape.removeAttribute('class');
    clipShape.removeAttribute('style');
    clipShape.removeAttribute('pointer-events');
    clipShape.setAttribute('fill', '#000000');
    clipShape.setAttribute('stroke', 'none');

    clipPath.appendChild(clipShape);
    ensureDefs(svg).appendChild(clipPath);

    target.dataset.clipPathId = clipId;
    return clipId;
  }

  function ensureDrawingLayer(parent) {
    let layer = Array.from(parent.children).find(child => child.classList?.contains('drawing-layer'));
    if (!layer) {
      layer = document.createElementNS(SVG_NS, 'g');
      layer.classList.add('drawing-layer');
      layer.setAttribute('pointer-events', 'none');
      parent.appendChild(layer);
    }

    return layer;
  }

  function createStrokePath(parent, clipId, color) {
    const pathEl = document.createElementNS(SVG_NS, 'path');
    pathEl.id = `trazo-${tabletId}-${Date.now()}-${++strokeCounter}`;
    pathEl.classList.add('draw-stroke');
    pathEl.setAttribute('clip-path', `url(#${clipId})`);
    pathEl.setAttribute('pointer-events', 'none');
    pathEl.style.fill = 'none';
    pathEl.style.stroke = color;
    pathEl.style.strokeWidth = `${BRUSH_SIZE_PX}`;
    pathEl.style.strokeLinecap = 'round';
    pathEl.style.strokeLinejoin = 'round';
    pathEl.style.vectorEffect = 'non-scaling-stroke';

    ensureDrawingLayer(parent).appendChild(pathEl);
    return pathEl;
  }

  function addPointToStroke(stroke, point) {
    const lastPoint = stroke.points[stroke.points.length - 1];
    if (lastPoint && distanceBetween(lastPoint, point) < stroke.minDistance) return;

    stroke.points.push(point);
    renderStroke(stroke);
  }

  function renderStroke(stroke) {
    stroke.pathEl.setAttribute('d', buildPathData(stroke.points));
  }

  function buildPathData(points) {
    const [firstPoint] = points;
    if (!firstPoint) return '';
    if (points.length === 1) {
      return `M ${formatNumber(firstPoint.x)} ${formatNumber(firstPoint.y)} l 0.01 0`;
    }

    const commands = [`M ${formatNumber(firstPoint.x)} ${formatNumber(firstPoint.y)}`];
    for (let i = 1; i < points.length; i += 1) {
      commands.push(`L ${formatNumber(points[i].x)} ${formatNumber(points[i].y)}`);
    }

    return commands.join(' ');
  }

  function distanceBetween(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function formatNumber(value) {
    return Number(value.toFixed(2));
  }

  function compactPoints(points) {
    return points.map(point => [formatNumber(point.x), formatNumber(point.y)]);
  }

  function setupColoringPaths(svg) {
    const colorableElements = svg.querySelectorAll('path, polygon, circle, ellipse, rect');

    colorableElements.forEach((el, index) => {
      if (!el.id) {
        el.id = `capa-${index + 1}`;
      }
      el.classList.add('colorable');
    });
  }

  // ========================
  // 5. PALETTE SELECTION
  // ========================
  paletteButtons.forEach(btn => {
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();

      // Update active button styling
      paletteButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      // Update current color
      currentColor = btn.getAttribute('data-color');
    });
  });

  // ========================
  // 6. CHARACTER SELECTION
  // ========================
  charButtons.forEach(btn => {
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();

      const svgFile = btn.getAttribute('data-svg');
      if (!svgFile || svgFile === currentSVG) return;

      // Update active character button
      charButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      // Load new SVG
      loadSVG(svgFile);
    });
  });

  // ========================
  // 7. INIT: Load default SVG
  // ========================
  loadSVG(currentSVG);

  // ========================
  // 8. DRAG AND DROP
  // ========================
  const dragOverlay = document.getElementById('drag-overlay');

  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragOverlay.classList.add('active');
  });

  window.addEventListener('dragover', (e) => {
    e.preventDefault(); // Necesario para permitir el drop
  });

  window.addEventListener('dragleave', (e) => {
    e.preventDefault();
    // Prevenir parpadeo cuando el cursor pasa por elementos internos
    if (e.relatedTarget === null) {
      dragOverlay.classList.remove('active');
    }
  });

  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragOverlay.classList.remove('active');

    const file = e.dataTransfer.files[0];
    if (file && (file.type === 'image/svg+xml' || file.name.endsWith('.svg'))) {
      const reader = new FileReader();
      reader.onload = (event) => {
        const svgText = event.target.result;
        
        // Deseleccionar botones de personajes porque ahora usamos uno custom
        charButtons.forEach(b => b.classList.remove('active'));
        activeStroke = null;
        currentSVG = 'custom_dropped_file';

        // Inyectar y preparar el SVG
        svgWrapper.innerHTML = svgText;
        const svg = svgWrapper.querySelector('svg');
        if (svg) {
          svg.removeAttribute('width');
          svg.removeAttribute('height');
          svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
          setupColoringPaths(svg);

          publishEvent('cambiar_personaje', {
            tabletId,
            svgFile: currentSVG,
            customSvgContent: svgText
          });
        } else {
          svgWrapper.innerHTML = '<div class="loading-msg">El archivo no contiene un SVG válido.</div>';
        }
      };
      reader.readAsText(file);
    }
  });
});
