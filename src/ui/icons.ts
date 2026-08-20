/**
 * Icon path data.
 *
 * Hand-written 24x24 stroke paths rather than an icon library. A dependency
 * would either be fetched from a CDN — impossible, since the built page must
 * make no external requests — or bundled in full for the dozen icons actually
 * used. These cost a few hundred bytes.
 */

export const ICONS = {
  select: 'M4 3l7 17 2.5-6.5L20 11z',
  pan: 'M9 11V5.5a1.5 1.5 0 013 0V11m0-1.5a1.5 1.5 0 013 0V13m0-2a1.5 1.5 0 013 0v5a5 5 0 01-5 5h-2.5a5 5 0 01-4-2L7 16s-1-1.5 0-2.5 2 0 2 0l1 1.5V7.5a1.5 1.5 0 00-3 0V13',
  rectangle: 'M4 5h16v14H4z',
  ellipse: 'M12 5c4.4 0 8 3.1 8 7s-3.6 7-8 7-8-3.1-8-7 3.6-7 8-7z',
  diamond: 'M12 4l8 8-8 8-8-8z',
  frame: 'M4 8h16v12H4z M4 8V4h16v4 M8 4v4 M16 4v4',
  line: 'M5 19L19 5',
  arrow: 'M5 19L19 5m0 0h-7m7 0v7',
  draw: 'M3 21s.5-3.5 2-5 9-9 9-9l3 3s-7.5 7.5-9 9-5 2-5 2zM14 7l3 3M16 5l3 3',
  text: 'M5 6V4h14v2M12 4v16M9 20h6',
  sticky: 'M5 4h14v10l-5 6H5z M19 14h-5v6',
  // A header rule across the full width and one column split below it, so the
  // table reads as a table at 16px rather than as the grid-toggle icon.
  table: 'M4 5h16v14H4z M4 9.5h16 M4 14.5h16 M11 9.5v9.5',
  image: 'M4 5h16v14H4z M4 15l4-4 3 3 4-5 5 6',
  eraser: 'M8 20H5l-2-2 11-11 6 6-7 7zm2-13l6 6',
  undo: 'M9 14L4 9l5-5 M4 9h11a5 5 0 010 10h-4',
  redo: 'M15 14l5-5-5-5 M20 9H9a5 5 0 000 10h4',
  zoomIn: 'M11 4a7 7 0 100 14 7 7 0 000-14z M20 20l-4-4 M11 8v6 M8 11h6',
  zoomOut: 'M11 4a7 7 0 100 14 7 7 0 000-14z M20 20l-4-4 M8 11h6',
  fit: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  menu: 'M4 7h16M4 12h16M4 17h16',
  newBoard: 'M14 4H6v16h12V10z M14 4v6h4 M12 13v5 M9.5 15.5h5',
  save: 'M5 4h11l3 3v13H5z M8 4v6h7V4 M8 20v-6h8v6',
  open: 'M4 6h6l2 2h8v10H4z',
  download: 'M12 4v11m0 0l-4-4m4 4l4-4 M5 19h14',
  drive: 'M8 4h8l5 9-4 7H7l-4-7z M8 4l5 9M16 4l-5 9M4 13h16',
  help: 'M12 4a8 8 0 100 16 8 8 0 000-16z M9.5 9.5a2.5 2.5 0 114 2c-.8.6-1.5 1.2-1.5 2.5 M12 17.5v.01',
  close: 'M6 6l12 12M18 6L6 18',
  trash: 'M4 7h16 M9 7V4h6v3 M6 7l1 13h10l1-13',
  front: 'M4 8l8-4 8 4-8 4z M4 12l8 4 8-4 M4 16l8 4 8-4',
  back: 'M4 16l8 4 8-4 M4 12l8-4 8 4 M12 4v8',
  group: 'M4 4h6v6H4z M14 14h6v6h-6z M4 14h6v6H4z M14 4h6v6h-6z',
  // Align and distribute: a rule showing the edge everything lands on, plus two
  // bars of different lengths so the direction of travel reads at 16px.
  alignLeft: 'M4 4v16 M7 8h11 M7 14h7',
  alignCenterX: 'M12 4v16 M6.5 8h11 M8.5 14h7',
  alignRight: 'M20 4v16 M6 8h11 M10 14h7',
  alignTop: 'M4 4h16 M8 7v11 M14 7v7',
  alignCenterY: 'M4 12h16 M8 6.5v11 M14 8.5v7',
  alignBottom: 'M4 20h16 M8 6v11 M14 10v7',
  distributeH: 'M4 4v16 M20 4v16 M10 7h4v10h-4z',
  distributeV: 'M4 4h16 M4 20h16 M7 10h10v4H7z',
  lock: 'M6 11h12v9H6z M9 11V7a3 3 0 016 0v4',
  grid: 'M4 4h16v16H4z M4 10h16M4 15h16M10 4v16M15 4v16',
  settings: 'M12 9a3 3 0 100 6 3 3 0 000-6z M19.4 14a1.6 1.6 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.6 1.6 0 00-1.8-.3 1.6 1.6 0 00-1 1.5V20a2 2 0 11-4 0v-.1A1.6 1.6 0 008 18.4a1.6 1.6 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.6 1.6 0 00.3-1.8 1.6 1.6 0 00-1.5-1H2a2 2 0 110-4h.1A1.6 1.6 0 003.6 8a1.6 1.6 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.6 1.6 0 001.8.3H8a1.6 1.6 0 001-1.5V2a2 2 0 114 0v.1a1.6 1.6 0 001 1.5 1.6 1.6 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.6 1.6 0 00-.3 1.8V8a1.6 1.6 0 001.5 1H22a2 2 0 110 4h-.1a1.6 1.6 0 00-1.5 1z',
} as const;

export type IconName = keyof typeof ICONS;
