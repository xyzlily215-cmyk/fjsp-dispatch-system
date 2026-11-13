const paths = {
  board: ['M4 4h16v16H4z', 'M4 10h16', 'M10 4v16'],
  twin: ['M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z', 'M4 7.5l8 4.5 8-4.5', 'M12 12v9'],
  database: ['M4 6c0-2 16-2 16 0v12c0 2-16 2-16 0z', 'M4 6c0 2 16 2 16 0', 'M4 12c0 2 16 2 16 0'],
  schedule: ['M5 4h14v16H5z', 'M8 2v4', 'M16 2v4', 'M5 9h14', 'M8 13h3', 'M8 16h6'],
  warning: ['M12 3L2.5 20h19L12 3z', 'M12 9v5', 'M12 17v.5'],
  analysis: ['M4 19V5', 'M4 19h16', 'M7 15l4-4 3 2 5-6'],
  review: ['M5 3h14v18H5z', 'M8 12l2.5 2.5L16 8', 'M8 7h5'],
  execution: ['M6 4h12v16H6z', 'M9 8h6', 'M10 12l5 3-5 3v-6z'],
  users: ['M8 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M2 21v-2c0-4 12-4 12 0v2', 'M16 4c4 0 4 6 0 7', 'M17 15c5 1 5 6 5 6'],
  dictionary: ['M4 5h6v14H4z', 'M14 5h6v14h-6z', 'M10 6h4', 'M10 10h4', 'M10 14h4'],
  timeline: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 7v5l3 2'],
  agent: ['M5 7h14v12H5z', 'M12 3v4', 'M9 12h.5', 'M15 12h.5', 'M9 16h6'],
  screen: ['M3 4h18v12H3z', 'M8 20h8', 'M12 16v4', 'M7 10l2 2 3-3 2 2 3-3'],
  refresh: ['M20 7v5h-5', 'M4 17v-5h5', 'M19 12a7 7 0 0 0-12-5L4 10', 'M5 12a7 7 0 0 0 12 5l3-3'],
  plus: ['M12 5v14', 'M5 12h14'],
  menu: ['M4 6h16', 'M4 12h16', 'M4 18h16'],
  back: ['M19 12H5', 'M11 6l-6 6 6 6'],
  fallback: ['M5 5h14v14H5z'],
};

export function iconPaths(name) {
  return [...(paths[name] || paths.fallback)];
}
