/**
 * Shape barrel.
 *
 * Importing this module registers every built-in element type. Each shape module
 * calls `registerElement` at import time, so the imports below are side-effecting
 * and must not be removed even though nothing here reads the exports.
 *
 * This file is the one place that knows the full list of built-in types. To add
 * a new shape, write `render/shapes/<type>.ts` and add one line here — see
 * `docs/09-extending.md` for the end-to-end walkthrough.
 */

import './rectangle.ts';
import './ellipse.ts';
import './linear.ts';
import './draw.ts';
import './text.ts';
import './sticky.ts';
import './image.ts';
import './diamond.ts';

export { rectangleDefinition } from './rectangle.ts';
export { ellipseDefinition } from './ellipse.ts';
export { linearDefinition } from './linear.ts';
export { drawDefinition } from './draw.ts';
export { textDefinition, measureTextElement } from './text.ts';
export { stickyDefinition, STICKY_DEFAULT_SIZE } from './sticky.ts';
export { imageDefinition } from './image.ts';
export { diamondDefinition } from './diamond.ts';
