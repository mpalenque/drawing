document.addEventListener('DOMContentLoaded', () => {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const SHAPE_SELECTOR = 'path, polygon, circle, ellipse, rect';
  const BRUSH_SIZE_PX = 18;

  const socket = typeof io !== 'undefined' ? io() : null;
  const urlParams = new URLSearchParams(window.location.search);
  const room = urlParams.get('room') || 'default';
  const channelKey = `toystory-sync-${room}`;
  const sourceId = `videowall-${Math.random().toString(36).slice(2, 8)}`;
  const syncChannel = !socket && typeof BroadcastChannel !== 'undefined'
    ? new BroadcastChannel(channelKey)
    : null;

  let clipCounter = 0;
  let strokeCounter = 0;

  const tabletStates = {
    1: { currentSVG: null },
    2: { currentSVG: null },
    3: { currentSVG: null },
    4: { currentSVG: null },
    5: { currentSVG: null },
    6: { currentSVG: null }
  };

  function loadSVGToSlot(tabletId, svgFile, customSvgContent = null) {
    const slotCanvas = document.getElementById(`canvas-${tabletId}`);
    const slotContainer = document.getElementById(`slot-${tabletId}`);
    if (!slotCanvas || !slotContainer) return;

    slotContainer.classList.add('active');

    if (svgFile === 'custom_dropped_file' && customSvgContent) {
      injectSVG(slotCanvas, customSvgContent, tabletId, svgFile);
      return;
    }

    fetch(svgFile)
      .then(res => res.text())
      .then(svgText => injectSVG(slotCanvas, svgText, tabletId, svgFile))
      .catch(err => console.error(`Error cargando ${svgFile} en tablet ${tabletId}`, err));
  }

  function injectSVG(slotCanvas, svgText, tabletId, svgFile) {
    slotCanvas.innerHTML = svgText;
    const svg = slotCanvas.querySelector('svg');
    if (!svg) return;

    svg.removeAttribute('width');
    svg.removeAttribute('height');
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    setupColoringSvg(svg);

    const slotContainer = document.getElementById(`slot-${tabletId}`);
    if (slotContainer) slotContainer.classList.add('has-svg');
    tabletStates[tabletId].currentSVG = svgFile;
  }

  function clearSlot(tabletId) {
    const slotCanvas = document.getElementById(`canvas-${tabletId}`);
    const slotContainer = document.getElementById(`slot-${tabletId}`);
    if (!slotCanvas || !slotContainer) return;

    slotCanvas.innerHTML = `<div class="empty-msg">Esperando a Tablet ${tabletId}...</div>`;
    slotContainer.classList.remove('active', 'has-svg');
    tabletStates[tabletId].currentSVG = null;
  }

  function setupColoringSvg(svg) {
    svg.classList.add('group-coloring-svg');

    const contour = findSvgElementById(svg, 'CONTORNO');
    if (contour) {
      contour.classList.add('locked-contour');
      contour.style.fill = '#000000';
      contour.style.stroke = 'none';
      contour.style.pointerEvents = 'none';
    }

    findColorableTargets(svg).forEach(target => {
      target.classList.add('colorable-group');
      target.dataset.colorGroup = target.id;
      getPaintableShapes(target).forEach(shape => {
        shape.classList.add('colorable');
        shape.dataset.colorGroupTarget = target.id;
        shape.style.fill = '#ffffff';
        shape.style.stroke = '#1a1a1a';
      });
    });
  }

  function findColorableTargets(svg) {
    const groups = Array.from(svg.querySelectorAll('g[id]'))
      .filter(group => group.id !== 'CONTORNO' && getPaintableShapes(group).length > 0);
    const groupedShapes = new Set(groups.flatMap(group => getPaintableShapes(group)));
    const namedShapes = Array.from(svg.querySelectorAll(`${SHAPE_SELECTOR}[id]`))
      .filter(shape => shape.id !== 'CONTORNO' && !groupedShapes.has(shape));
    return [...groups, ...namedShapes];
  }

  function applyStrokeToSlot(slotCanvas, strokeData) {
    const svg = slotCanvas.querySelector('svg');
    if (!svg) return;

    const target = findSvgElementById(svg, strokeData.elementId);
    if (!target) return;

    const parent = getDrawableParent(target);
    const points = (strokeData.points || []).map(([x, y]) => ({ x, y }));
    if (!points.length) return;

    const clipId = ensureClipPathForTarget(svg, target);
    const pathEl = createStrokePath(parent, clipId, strokeData.color, strokeData.brushSizePx);
    pathEl.setAttribute('d', buildPathData(points));
  }

  function getDrawableParent(target) {
    return target.ownerSVGElement || target;
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

    const clipId = `wall-clip-${sourceId}-${++clipCounter}`;
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

  function createStrokePath(parent, clipId, color, brushSizePx = BRUSH_SIZE_PX) {
    const pathEl = document.createElementNS(SVG_NS, 'path');
    pathEl.id = `trazo-wall-${Date.now()}-${++strokeCounter}`;
    pathEl.classList.add('draw-stroke');
    pathEl.setAttribute('clip-path', `url(#${clipId})`);
    pathEl.setAttribute('pointer-events', 'none');
    pathEl.style.fill = 'none';
    pathEl.style.stroke = color || '#000000';
    pathEl.style.strokeWidth = `${brushSizePx || BRUSH_SIZE_PX}`;
    pathEl.style.strokeLinecap = 'round';
    pathEl.style.strokeLinejoin = 'round';
    pathEl.style.vectorEffect = 'non-scaling-stroke';
    ensureDrawingLayer(parent).appendChild(pathEl);
    return pathEl;
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

  function formatNumber(value) {
    return Number(value.toFixed(2));
  }

  function findSvgElementById(svg, id) {
    if (!svg || !id) return null;
    if (window.CSS?.escape) return svg.querySelector(`#${CSS.escape(id)}`);
    return Array.from(svg.querySelectorAll('[id]')).find(el => el.id === id) || null;
  }

  function handleSyncEvent(data) {
    if (!data || !data.type || !data.payload) return;

    if (data.type === 'cambiar_personaje') {
      const { tabletId, svgFile, customSvgContent } = data.payload;
      if (tabletId >= 1 && tabletId <= 6) {
        loadSVGToSlot(tabletId, svgFile, customSvgContent);
      }
      return;
    }

    if (data.type === 'terminar_dibujo') {
      const { tabletId } = data.payload;
      if (tabletId >= 1 && tabletId <= 6) clearSlot(tabletId);
      return;
    }

    if (data.type === 'dibujar_trazo') {
      const { tabletId, svgFile } = data.payload;
      if (tabletId < 1 || tabletId > 6) return;

      if (tabletStates[tabletId].currentSVG !== svgFile) {
        console.warn(`Desincronizacion en tablet ${tabletId}. Tiene ${tabletStates[tabletId].currentSVG}, recibio ${svgFile}`);
      }

      const slotCanvas = document.getElementById(`canvas-${tabletId}`);
      if (slotCanvas) applyStrokeToSlot(slotCanvas, data.payload);
    }
  }

  if (socket) {
    socket.on('cambiar_personaje', payload => handleSyncEvent({ type: 'cambiar_personaje', payload }));
    socket.on('dibujar_trazo', payload => handleSyncEvent({ type: 'dibujar_trazo', payload }));
    socket.on('terminar_dibujo', payload => handleSyncEvent({ type: 'terminar_dibujo', payload }));
  } else {
    console.info('Socket.io no disponible. Usando sincronizacion local.');

    if (syncChannel) {
      syncChannel.onmessage = (event) => {
        const message = event.data;
        if (!message || message.sourceId === sourceId) return;
        handleSyncEvent(message);
      };
    }

    window.addEventListener('storage', (event) => {
      if (event.key !== channelKey || !event.newValue) return;
      try {
        const message = JSON.parse(event.newValue);
        if (!message || message.sourceId === sourceId) return;
        handleSyncEvent(message);
      } catch (err) {
        console.warn('No se pudo parsear evento local:', err);
      }
    });
  }
});
