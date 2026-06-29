document.addEventListener('DOMContentLoaded', () => {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const SHAPE_SELECTOR = 'path, polygon, circle, ellipse, rect';
  const BRUSH_SIZE_PX = 18;
  const MIN_POINT_DISTANCE_PX = 2.5;
  const PAINT_SECONDS = 180;
  const SOUND_FOUND_TOY = 'found_toy.wav';
  const SOUND_GAME_OVER = 'game_over.mp3';

  function playSound(src) {
    try {
      const audio = new Audio(src);
      audio.currentTime = 0;
      const played = audio.play();
      if (played && typeof played.catch === 'function') played.catch(() => {});
    } catch (err) {
      // Si el navegador bloquea o no soporta audio, el juego sigue funcionando.
    }
  }

  let currentColor = '#000000';
  let currentSVG = null;
  let activeStroke = null;
  let clipCounter = 0;
  let strokeCounter = 0;
  let timerId = null;
  let timeLeft = PAINT_SECONDS;
  let baseViewBox = null;
  let viewportViewBox = null;
  let zoomGesture = null;
  const activePointers = new Map();

  const urlParams = new URLSearchParams(window.location.search);
  const tabletId = Number.parseInt(urlParams.get('tabletId'), 10) || 1;
  const room = urlParams.get('room') || 'default';
  const channelKey = `toystory-sync-${room}`;
  const sourceId = `tablet-${tabletId}-${Math.random().toString(36).slice(2, 8)}`;

  const socket = typeof io !== 'undefined' ? io() : null;
  const syncChannel = !socket && typeof BroadcastChannel !== 'undefined'
    ? new BroadcastChannel(channelKey)
    : null;

  const selectScreen = document.getElementById('select-screen');
  const paintScreen = document.getElementById('paint-screen');
  const svgWrapper = document.getElementById('svg-wrapper');
  const palette = document.getElementById('palette');
  const timerEl = document.getElementById('timer');
  const referenceBubble = document.getElementById('reference-bubble');
  const referenceImage = document.getElementById('reference-image');
  const choiceButtons = document.querySelectorAll('.choice-btn');
  const backButton = document.getElementById('back-to-select');

  function publishEvent(type, payload) {
    if (socket && socket.connected) {
      socket.emit(type, payload);
      return;
    }

    const message = { type, payload, sourceId, timestamp: Date.now() };
    if (syncChannel) syncChannel.postMessage(message);

    try {
      localStorage.setItem(channelKey, JSON.stringify(message));
    } catch (err) {
      console.warn('No se pudo publicar evento de sincronizacion local:', err);
    }
  }

  if (socket) {
    socket.on('connect', () => {
      if (currentSVG) {
        publishEvent('cambiar_personaje', { tabletId, svgFile: currentSVG });
      }
    });
  }

  window.addEventListener('pointerup', handlePointerEnd);
  window.addEventListener('pointercancel', handlePointerEnd);
  svgWrapper.addEventListener('pointerdown', handleCanvasPointerDown);
  svgWrapper.addEventListener('pointermove', handleCanvasPointerMove);
  svgWrapper.addEventListener('wheel', handleCanvasWheel, { passive: false });

  choiceButtons.forEach(btn => {
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const svgFile = btn.getAttribute('data-svg');
      if (svgFile) startCharacter(svgFile);
    });
  });

  backButton.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    returnToSelect(true);
  });

  function startCharacter(svgFile) {
    playSound(SOUND_FOUND_TOY);
    selectScreen.classList.remove('active');
    paintScreen.classList.add('active');
    loadSVG(svgFile);
  }

  function returnToSelect(announce) {
    activeStroke = null;
    stopTimer();
    currentSVG = null;
    activePointers.clear();
    zoomGesture = null;
    resetViewportTransform();
    svgWrapper.innerHTML = '<div class="loading-msg">Cargando...</div>';
    clearReferenceImage();
    palette.innerHTML = '';
    paintScreen.classList.remove('active');
    selectScreen.classList.add('active');

    if (announce) {
      publishEvent('terminar_dibujo', { tabletId });
    }
  }

  function loadSVG(filename) {
    activeStroke = null;
    currentSVG = filename;
    activePointers.clear();
    zoomGesture = null;
    resetViewportTransform();
    svgWrapper.innerHTML = '<div class="loading-msg">Cargando...</div>';
    setReferenceImage(filename);

    fetch(filename)
      .then(res => {
        if (!res.ok) throw new Error(`HTTP error ${res.status}`);
        return res.text();
      })
      .then(svgText => {
        svgWrapper.innerHTML = svgText;

        const svg = svgWrapper.querySelector('svg');
        if (!svg) return;

        // Guardamos el viewBox original para hacer zoom vectorial, sin escalar por CSS.
        baseViewBox = parseViewBox(svg);
        viewportViewBox = { ...baseViewBox };
        svg.removeAttribute('width');
        svg.removeAttribute('height');
        svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
        svg.setAttribute('shape-rendering', 'geometricPrecision');
        svg.setAttribute('text-rendering', 'geometricPrecision');
        applyViewportTransform();

        const setup = setupColoringSvg(svg);
        buildPalette(setup.paletteColors);
        startTimer();

        publishEvent('cambiar_personaje', { tabletId, svgFile: currentSVG });
      })
      .catch(err => {
        console.error('Error loading SVG:', err);
        svgWrapper.innerHTML = '<div class="loading-msg">Error al cargar el dibujo.</div>';
        clearReferenceImage();
      });
  }

  function setReferenceImage(filename) {
    if (!referenceBubble || !referenceImage) return;
    referenceImage.src = filename;
    referenceBubble.classList.add('is-visible');
  }

  function clearReferenceImage() {
    if (!referenceBubble || !referenceImage) return;
    referenceImage.removeAttribute('src');
    referenceBubble.classList.remove('is-visible');
  }

  function handleCanvasPointerDown(e) {
    const svg = svgWrapper.querySelector('svg');
    if (!svg) return;

    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    try {
      svgWrapper.setPointerCapture(e.pointerId);
    } catch (err) {
      // Some webviews do not allow pointer capture; drawing and zoom still work.
    }

    if (e.pointerType === 'touch' && activePointers.size >= 2) {
      e.preventDefault();
      e.stopPropagation();
      cancelActiveStroke();
      startZoomGesture();
      return;
    }

    if (activePointers.size > 1) return;
    startDrawing(e);
  }

  function handleCanvasPointerMove(e) {
    if (activePointers.has(e.pointerId)) {
      activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }

    if (zoomGesture && activePointers.size >= 2) {
      e.preventDefault();
      e.stopPropagation();
      updateZoomGesture();
      return;
    }

    continueDrawing(e);
  }

  function handlePointerEnd(e) {
    const wasTracked = activePointers.delete(e.pointerId);

    if (zoomGesture) {
      e.preventDefault();
      e.stopPropagation();
      zoomGesture = null;
      if (wasTracked && activePointers.size === 1) cancelActiveStroke();
      return;
    }

    finishDrawing(e);
  }

  function handleCanvasWheel(e) {
    const svg = svgWrapper.querySelector('svg');
    if (!svg) return;

    e.preventDefault();
    const factor = Math.exp(-e.deltaY * 0.0015);
    zoomAroundPoint(factor, e.clientX, e.clientY);
  }

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
    // El ancho del pincel se mide en unidades del dibujo (no en pixeles de pantalla),
    // asi el trazo escala con el zoom y no aparecen huecos al acercar.
    const brushWidth = screenDistanceToLocal(parent, BRUSH_SIZE_PX);
    const pathEl = createStrokePath(parent, clipId, currentColor, brushWidth);

    activeStroke = {
      pointerId: e.pointerId,
      svg,
      parent,
      target,
      pathEl,
      color: currentColor,
      brushWidth,
      points: [point],
      minDistance: screenDistanceToLocal(parent, MIN_POINT_DISTANCE_PX)
    };

    renderStroke(activeStroke);

    try {
      svgWrapper.setPointerCapture(e.pointerId);
    } catch (err) {
      // Some webviews do not allow pointer capture; drawing still works.
    }
  }

  function continueDrawing(e) {
    if (!activeStroke || e.pointerId !== activeStroke.pointerId) return;

    e.preventDefault();
    e.stopPropagation();

    const point = clientPointToLocal(activeStroke.parent, e.clientX, e.clientY);
    if (point) addPointToStroke(activeStroke, point);
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
      // Pointer capture may not have been granted.
    }

    publishEvent('dibujar_trazo', {
      tabletId,
      svgFile: currentSVG,
      elementId: finishedStroke.target.id,
      color: finishedStroke.color,
      brushSizePx: finishedStroke.brushWidth,
      points: compactPoints(finishedStroke.points)
    });
  }

  function cancelActiveStroke() {
    if (!activeStroke) return;

    activeStroke.pathEl.remove();
    activeStroke = null;
  }

  function startZoomGesture() {
    const svg = svgWrapper.querySelector('svg');
    const points = getFirstTwoPointers();
    if (!svg || !points) return;

    const center = midpoint(points[0], points[1]);
    const anchor = clientPointToLocal(svg, center.x, center.y);
    if (!anchor) return;

    zoomGesture = {
      startDistance: distanceBetween(points[0], points[1]),
      startAnchor: anchor,
      startScale: getCurrentViewportScale()
    };
  }

  function updateZoomGesture() {
    if (!zoomGesture) return;
    const svg = svgWrapper.querySelector('svg');
    if (!svg) return;

    const points = getFirstTwoPointers();
    if (!points) return;

    const distance = distanceBetween(points[0], points[1]);
    if (!distance || !zoomGesture.startDistance) return;

    const center = midpoint(points[0], points[1]);
    const nextScale = clamp(
      zoomGesture.startScale * (distance / zoomGesture.startDistance),
      1,
      4
    );

    zoomToAnchor(
      svg,
      zoomGesture.startAnchor,
      toWrapperPoint(center),
      nextScale
    );
  }

  function zoomAroundPoint(factor, clientX, clientY) {
    const center = toWrapperPoint({ x: clientX, y: clientY });
    const svg = svgWrapper.querySelector('svg');
    if (!svg) return;

    const anchor = clientPointToLocal(svg, clientX, clientY);
    if (!anchor) return;

    const nextScale = clamp(getCurrentViewportScale() * factor, 1, 4);
    zoomToAnchor(svg, anchor, center, nextScale);
  }

  function resetViewportTransform() {
    viewportViewBox = baseViewBox ? { ...baseViewBox } : null;
  }

  function applyViewportTransform() {
    const svg = svgWrapper.querySelector('svg');
    if (!svg || !viewportViewBox) return;

    if (getCurrentViewportScale() <= 1.001 && baseViewBox) {
      viewportViewBox = { ...baseViewBox };
    }

    svg.style.transform = 'none';
    svg.style.willChange = 'auto';
    svg.setAttribute('viewBox', serializeViewBox(viewportViewBox));
  }

  function zoomToAnchor(svg, anchor, wrapperPoint, nextScale) {
    if (!baseViewBox || !viewportViewBox) return;

    if (nextScale <= 1.001) {
      resetViewportTransform();
      applyViewportTransform();
      return;
    }

    // Mantener el SVG nítido: ajustamos el viewBox en lugar de aplicar scale() al nodo.
    const nextViewBox = {
      width: baseViewBox.width / nextScale,
      height: baseViewBox.height / nextScale
    };
    const metrics = getViewportMetrics(nextViewBox);

    viewportViewBox = {
      x: anchor.x - (wrapperPoint.x - metrics.offsetX) / metrics.scale,
      y: anchor.y - (wrapperPoint.y - metrics.offsetY) / metrics.scale,
      width: nextViewBox.width,
      height: nextViewBox.height
    };

    applyViewportTransform();
  }

  function getFirstTwoPointers() {
    const points = Array.from(activePointers.values());
    if (points.length < 2) return null;
    return [points[0], points[1]];
  }

  function midpoint(a, b) {
    return {
      x: (a.x + b.x) / 2,
      y: (a.y + b.y) / 2
    };
  }

  function toWrapperPoint(point) {
    const rect = svgWrapper.getBoundingClientRect();
    return {
      x: point.x - rect.left,
      y: point.y - rect.top
    };
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function getCurrentViewportScale() {
    if (!baseViewBox || !viewportViewBox || !viewportViewBox.width) return 1;
    return baseViewBox.width / viewportViewBox.width;
  }

  function getViewportMetrics(viewBox) {
    const rect = svgWrapper.getBoundingClientRect();
    const scale = Math.min(rect.width / viewBox.width, rect.height / viewBox.height);
    return {
      scale,
      offsetX: (rect.width - viewBox.width * scale) / 2,
      offsetY: (rect.height - viewBox.height * scale) / 2
    };
  }

  function serializeViewBox(viewBox) {
    return [
      formatViewBoxNumber(viewBox.x),
      formatViewBoxNumber(viewBox.y),
      formatViewBoxNumber(viewBox.width),
      formatViewBoxNumber(viewBox.height)
    ].join(' ');
  }

  function formatViewBoxNumber(value) {
    return Number(value.toFixed(4));
  }

  function parseViewBox(svg) {
    const raw = svg.getAttribute('viewBox');
    if (raw) {
      const values = raw.trim().split(/[\s,]+/).map(Number);
      if (values.length === 4 && values.every(Number.isFinite)) {
        return {
          x: values[0],
          y: values[1],
          width: values[2],
          height: values[3]
        };
      }
    }

    const width = Number.parseFloat(svg.getAttribute('width')) || 100;
    const height = Number.parseFloat(svg.getAttribute('height')) || 100;
    return { x: 0, y: 0, width, height };
  }

  function setupColoringSvg(svg) {
    const styleColors = parseSvgStyleColors(svg);
    const colorableGroups = findColorableTargets(svg);
    const paletteColors = [];

    svg.classList.add('group-coloring-svg');

    const contour = findSvgElementById(svg, 'CONTORNO');
    if (contour) {
      contour.classList.add('locked-contour');
      contour.style.fill = '#000000';
      contour.style.stroke = 'none';
      contour.style.pointerEvents = 'none';
    }

    colorableGroups.forEach(target => {
      const color = inferTargetColor(target, styleColors) || '#ffffff';
      target.classList.add('colorable-group');
      target.dataset.colorGroup = target.id;
      target.dataset.originalColor = color;
      if (color.toUpperCase() !== '#000000' && !paletteColors.includes(color)) {
        paletteColors.push(color);
      }

      getPaintableShapes(target).forEach(shape => {
        shape.classList.add('colorable');
        shape.dataset.colorGroupTarget = target.id;
        shape.style.fill = '#ffffff';
        shape.style.stroke = '#1a1a1a';
        shape.style.pointerEvents = 'auto';
      });
    });

    if (!paletteColors.length) {
      paletteColors.push('#E72E20', '#DC961F', '#52A4C1', '#699F58', '#562E6B', '#E0B090');
    }

    return { paletteColors };
  }

  function parseSvgStyleColors(svg) {
    const colors = new Map();
    const styleText = Array.from(svg.querySelectorAll('style'))
      .map(style => style.textContent || '')
      .join('\n');
    const re = /\.([A-Za-z0-9_-]+)\s*\{\s*fill\s*:\s*(#[0-9A-Fa-f]{3,8})\s*;?\s*\}/g;
    let match;
    while ((match = re.exec(styleText))) {
      colors.set(match[1], normalizeHex(match[2]));
    }
    return colors;
  }

  function findColorableTargets(svg) {
    const groups = Array.from(svg.querySelectorAll('g[id]'))
      .filter(group => group.id !== 'CONTORNO' && getPaintableShapes(group).length > 0);
    const groupedShapes = new Set(groups.flatMap(group => getPaintableShapes(group)));
    const namedShapes = Array.from(svg.querySelectorAll(`${SHAPE_SELECTOR}[id]`))
      .filter(shape => shape.id !== 'CONTORNO' && !groupedShapes.has(shape));
    return [...groups, ...namedShapes];
  }

  function inferTargetColor(target, styleColors) {
    const shape = target.matches(SHAPE_SELECTOR) ? target : getPaintableShapes(target)[0];
    if (!shape) return null;

    for (const className of shape.classList) {
      if (styleColors.has(className)) return styleColors.get(className);
    }

    const fill = shape.getAttribute('fill') || shape.style.fill;
    return normalizeHex(fill);
  }

  function normalizeHex(value) {
    if (!value || !value.startsWith('#')) return null;
    const hex = value.trim();
    if (hex.length === 4) {
      return `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`.toUpperCase();
    }
    return hex.slice(0, 7).toUpperCase();
  }

  function buildPalette(colors) {
    palette.innerHTML = '';
    colors.forEach((color, index) => {
      const btn = document.createElement('button');
      btn.className = `color-btn${index === 0 ? ' active' : ''}`;
      btn.type = 'button';
      btn.dataset.color = color;
      btn.style.backgroundColor = color;
      btn.setAttribute('aria-label', color);
      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        setCurrentColor(color, btn);
      });
      palette.appendChild(btn);
    });

    const eraseBtn = document.createElement('button');
    eraseBtn.className = 'color-btn erase-btn';
    eraseBtn.type = 'button';
    eraseBtn.dataset.color = '#FFFFFF';
    eraseBtn.setAttribute('aria-label', 'Borrar');
    eraseBtn.textContent = '×';
    eraseBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      setCurrentColor('#FFFFFF', eraseBtn);
    });
    palette.appendChild(eraseBtn);

    setCurrentColor(colors[0] || '#000000', palette.querySelector('.color-btn'));
  }

  function setCurrentColor(color, activeButton) {
    currentColor = color;
    palette.querySelectorAll('.color-btn').forEach(btn => btn.classList.remove('active'));
    if (activeButton) activeButton.classList.add('active');
  }

  function getColorableTargetAtPoint(clientX, clientY) {
    const targets = document.elementsFromPoint
      ? document.elementsFromPoint(clientX, clientY)
      : [document.elementFromPoint(clientX, clientY)];

    for (const target of targets) {
      if (!target || !svgWrapper.contains(target) || !(target instanceof Element)) continue;
      const colorable = target.matches(SHAPE_SELECTOR) ? target : target.closest(SHAPE_SELECTOR);
      if (!colorable || !svgWrapper.contains(colorable)) continue;

      const groupId = colorable.dataset.colorGroupTarget;
      if (groupId) {
        const groupedTarget = findSvgElementById(colorable.ownerSVGElement, groupId);
        if (groupedTarget) return groupedTarget;
      }

      if (colorable.classList.contains('colorable-group') || colorable.classList.contains('colorable')) {
        return colorable;
      }
    }

    return null;
  }

  function getDrawableParent(target) {
    return target.ownerSVGElement || target;
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
    clipPath.id = clipId;
    clipPath.setAttribute('clipPathUnits', 'userSpaceOnUse');

    appendClipShapes(clipPath, target);
    ensureDefs(svg).appendChild(clipPath);

    target.dataset.clipPathId = clipId;
    return clipId;
  }

  function appendClipShapes(clipPath, target) {
    const shapes = target.matches(SHAPE_SELECTOR) ? [target] : getPaintableShapes(target);
    shapes.forEach(shape => {
      const clipShape = shape.cloneNode(false);
      prepareClipShape(clipShape);
      clipPath.appendChild(clipShape);
    });
  }

  function prepareClipShape(root) {
    root.removeAttribute('id');
    root.removeAttribute('class');
    root.removeAttribute('style');
    root.removeAttribute('pointer-events');
    root.setAttribute('fill', '#000000');
    root.setAttribute('stroke', 'none');
  }

  function getPaintableShapes(target) {
    const shapes = target.matches(SHAPE_SELECTOR)
      ? [target]
      : Array.from(target.querySelectorAll(SHAPE_SELECTOR));

    return shapes.filter(shape => (
      shape.id !== 'CONTORNO' &&
      !shape.closest('.drawing-layer') &&
      !shape.classList.contains('draw-stroke')
    ));
  }

  function createStrokePath(parent, clipId, color, brushWidth = BRUSH_SIZE_PX) {
    const pathEl = document.createElementNS(SVG_NS, 'path');
    pathEl.id = `trazo-${tabletId}-${Date.now()}-${++strokeCounter}`;
    pathEl.classList.add('draw-stroke');
    pathEl.setAttribute('clip-path', `url(#${clipId})`);
    pathEl.setAttribute('pointer-events', 'none');
    pathEl.style.fill = 'none';
    pathEl.style.stroke = color;
    pathEl.style.strokeWidth = `${brushWidth}`;
    pathEl.style.strokeLinecap = 'round';
    pathEl.style.strokeLinejoin = 'round';
    // Trazo en unidades del dibujo => escala con el zoom (sin non-scaling-stroke).
    pathEl.style.vectorEffect = 'none';

    ensureDrawingLayer(parent).appendChild(pathEl);
    return pathEl;
  }

  function ensureDrawingLayer(parent) {
    const svg = parent.ownerSVGElement || parent;
    let layer = Array.from(svg.children).find(child => child.classList?.contains('drawing-layer'));
    if (!layer) {
      layer = document.createElementNS(SVG_NS, 'g');
      layer.classList.add('drawing-layer');
      layer.setAttribute('pointer-events', 'none');
      svg.appendChild(layer);
    }
    return layer;
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

  function findSvgElementById(svg, id) {
    if (!svg || !id) return null;
    if (window.CSS?.escape) return svg.querySelector(`#${CSS.escape(id)}`);
    return Array.from(svg.querySelectorAll('[id]')).find(el => el.id === id) || null;
  }

  function startTimer() {
    stopTimer();
    timeLeft = PAINT_SECONDS;
    updateTimer();
    timerId = window.setInterval(() => {
      timeLeft -= 1;
      updateTimer();
      if (timeLeft <= 0) {
        playSound(SOUND_GAME_OVER);
        returnToSelect(true);
      }
    }, 1000);
  }

  function stopTimer() {
    if (timerId) {
      window.clearInterval(timerId);
      timerId = null;
    }
  }

  function updateTimer() {
    const minutes = Math.floor(Math.max(timeLeft, 0) / 60).toString().padStart(2, '0');
    const seconds = (Math.max(timeLeft, 0) % 60).toString().padStart(2, '0');
    timerEl.textContent = `${minutes}:${seconds}`;
  }
});
