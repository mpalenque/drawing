document.addEventListener('DOMContentLoaded', () => {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const BRUSH_SIZE_PX = 18;
  const SHAPE_SELECTOR = 'path, polygon, circle, ellipse, rect';
  const COLORABLE_GROUP_IDS = [
    'PIEL',
    'VIOLETA',
    'VERDE',
    'ROJO',
    'ORO',
    'CELESTE',
    'GRIS_CLARO',
    'GRIS_MEDIO',
    'GRIS_OSCURO'
  ];

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

  // Estado local del videowall para saber qué SVG tiene cada tablet cargado
  const tabletStates = {
    1: { currentSVG: null },
    2: { currentSVG: null },
    3: { currentSVG: null },
    4: { currentSVG: null },
    5: { currentSVG: null },
    6: { currentSVG: null }
  };

  // Función para cargar un SVG en una ranura específica
  function loadSVGToSlot(tabletId, svgFile, customSvgContent = null) {
    const slotCanvas = document.getElementById(`canvas-${tabletId}`);
    const slotContainer = document.getElementById(`slot-${tabletId}`);
    if (!slotCanvas || !slotContainer) return;

    slotContainer.classList.add('active');

    // Si es un archivo custom droppeado
    if (svgFile === 'custom_dropped_file' && customSvgContent) {
      injectSVG(slotCanvas, customSvgContent, tabletId, svgFile);
      return;
    }

    // Si es uno de los predeterminados, hacer fetch
    fetch(svgFile)
      .then(res => res.text())
      .then(svgText => {
        injectSVG(slotCanvas, svgText, tabletId, svgFile);
      })
      .catch(err => {
        console.error(`Error cargando ${svgFile} en tablet ${tabletId}`, err);
      });
  }

  function injectSVG(slotCanvas, svgText, tabletId, svgFile) {
    slotCanvas.innerHTML = svgText;
    const svg = slotCanvas.querySelector('svg');
    if (svg) {
      svg.removeAttribute('width');
      svg.removeAttribute('height');
      svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
      
      // Mark slot as active (white background)
      const slotContainer = document.getElementById(`slot-${tabletId}`);
      if (slotContainer) slotContainer.classList.add('has-svg');

      setupColoringPaths(svg);
      
      tabletStates[tabletId].currentSVG = svgFile;
    }
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

  function findSvgElementById(svg, id) {
    if (!id) return null;

    if (window.CSS?.escape) {
      return svg.querySelector(`#${CSS.escape(id)}`);
    }

    return Array.from(svg.querySelectorAll('[id]')).find(el => el.id === id) || null;
  }

  function normalizeColorGroupName(id) {
    const normalizedId = (id || '').toUpperCase();
    return COLORABLE_GROUP_IDS.find(groupId => (
      normalizedId === groupId || normalizedId.startsWith(`${groupId}_`)
    )) || null;
  }

  function isInsideColorableGroup(el) {
    return Boolean(el.parentElement?.closest?.('g.colorable-group'));
  }

  function markColorableTarget(el, groupName) {
    if (!el.id) {
      el.id = groupName || `grupo-color-${Date.now()}`;
    }

    if (el.matches(SHAPE_SELECTOR)) {
      el.classList.add('colorable');
    }
    el.classList.add('colorable-group');
    el.dataset.colorGroup = groupName || el.id;
  }

  function markGroupShapes(group, groupName) {
    getPaintableShapes(group).forEach(el => {
      el.classList.add('colorable');
      el.dataset.colorGroupTarget = group.id;
      el.dataset.colorGroup = groupName || group.id;
    });
  }

  function getPaintableShapes(target) {
    const shapes = target.matches(SHAPE_SELECTOR)
      ? [target]
      : Array.from(target.querySelectorAll(SHAPE_SELECTOR));

    return shapes.filter(el => (
      el.id !== 'CONTORNO' &&
      !el.closest('.drawing-layer') &&
      !el.classList.contains('draw-stroke')
    ));
  }

  function paintColorTarget(target, color) {
    getPaintableShapes(target).forEach(el => {
      el.style.fill = color;
    });
  }

  function setupColoringPaths(svg) {
    const contour = findSvgElementById(svg, 'CONTORNO');
    if (contour) {
      contour.classList.add('locked-contour');
      contour.style.fill = '#000000';
      contour.style.stroke = 'none';
      contour.style.pointerEvents = 'none';
    }

    const namedGroups = Array.from(svg.querySelectorAll('g[id]'))
      .map(el => ({ el, groupName: normalizeColorGroupName(el.id) }))
      .filter(item => item.groupName);

    const namedShapes = Array.from(svg.querySelectorAll(`${SHAPE_SELECTOR}[id]`))
      .map(el => ({ el, groupName: normalizeColorGroupName(el.id) }))
      .filter(item => item.groupName && !isInsideColorableGroup(item.el));

    if (namedGroups.length || namedShapes.length) {
      svg.classList.add('group-coloring-svg');
      namedGroups.forEach(({ el, groupName }) => {
        markColorableTarget(el, groupName);
        markGroupShapes(el, groupName);
      });
      namedShapes.forEach(({ el, groupName }) => markColorableTarget(el, groupName));
      return;
    }

    const colorableElements = svg.querySelectorAll(SHAPE_SELECTOR);
    colorableElements.forEach((el, index) => {
      if (el.id === 'CONTORNO') return;
      if (!el.id) {
        el.id = `capa-${index + 1}`;
      }
    });
  }

  function getDrawableParent(target) {
    return target.parentNode instanceof SVGElement ? target.parentNode : target.ownerSVGElement;
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
    const shapes = target.matches(SHAPE_SELECTOR)
      ? [target]
      : getPaintableShapes(target);

    shapes.forEach(shape => {
      const clipShape = shape.cloneNode(false);
      prepareClipShape(clipShape);
      clipPath.appendChild(clipShape);
    });
  }

  function prepareClipShape(root) {
    const elements = [root, ...Array.from(root.querySelectorAll('*'))];
    elements.forEach(el => {
      el.removeAttribute('id');
      el.removeAttribute('class');
      el.removeAttribute('style');
      el.removeAttribute('pointer-events');
      if (el.matches?.(SHAPE_SELECTOR)) {
        el.setAttribute('fill', '#000000');
        el.setAttribute('stroke', 'none');
      }
    });
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

  function createStrokePath(parent, clipId, color, brushSizePx = BRUSH_SIZE_PX) {
    const pathEl = document.createElementNS(SVG_NS, 'path');
    pathEl.id = `trazo-wall-${Date.now()}-${++strokeCounter}`;
    pathEl.classList.add('draw-stroke');
    pathEl.setAttribute('clip-path', `url(#${clipId})`);
    pathEl.setAttribute('pointer-events', 'none');
    pathEl.style.fill = 'none';
    pathEl.style.stroke = color || '#d62828';
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

  function handleSyncEvent(data) {
    if (!data || !data.type || !data.payload) return;

    if (data.type === 'cambiar_personaje') {
      const { tabletId, svgFile, customSvgContent } = data.payload;
      if (tabletId >= 1 && tabletId <= 6) {
        loadSVGToSlot(tabletId, svgFile, customSvgContent);
      }
      return;
    }

    if (data.type === 'pintar_capa') {
      const { tabletId, svgFile, elementId, color } = data.payload;
      if (tabletId < 1 || tabletId > 6) return;

      // Si la tablet tiene un SVG diferente cargado al que nosotros tenemos, sincronizamos primero.
      if (tabletStates[tabletId].currentSVG !== svgFile) {
        console.warn(`Desincronización en tablet ${tabletId}. Tiene ${svgFile} pero el videowall tiene ${tabletStates[tabletId].currentSVG}`);
      }

      const slotCanvas = document.getElementById(`canvas-${tabletId}`);
      if (slotCanvas) {
        const svg = slotCanvas.querySelector('svg');
        const targetToColor = svg ? findSvgElementById(svg, elementId) : null;
        if (targetToColor) {
          paintColorTarget(targetToColor, color);
        }
      }
    }

    if (data.type === 'dibujar_trazo') {
      const { tabletId, svgFile } = data.payload;
      if (tabletId < 1 || tabletId > 6) return;

      if (tabletStates[tabletId].currentSVG !== svgFile) {
        console.warn(`Desincronización en tablet ${tabletId}. Tiene ${svgFile} pero el videowall tiene ${tabletStates[tabletId].currentSVG}`);
      }

      const slotCanvas = document.getElementById(`canvas-${tabletId}`);
      if (slotCanvas) {
        applyStrokeToSlot(slotCanvas, data.payload);
      }
    }
  }

  // Escuchar cuando una tablet cambia de personaje
  if (socket) {
    socket.on('cambiar_personaje', (payload) => {
      handleSyncEvent({ type: 'cambiar_personaje', payload });
    });

    socket.on('pintar_capa', (payload) => {
      handleSyncEvent({ type: 'pintar_capa', payload });
    });

    socket.on('dibujar_trazo', (payload) => {
      handleSyncEvent({ type: 'dibujar_trazo', payload });
    });
  } else {
    console.info('Socket.io no disponible. Usando sincronización local para GitHub Pages.');

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
        console.warn('No se pudo parsear evento local de sincronización:', err);
      }
    });
  }
});
