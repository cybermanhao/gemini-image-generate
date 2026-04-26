import type { Application } from 'express';
import * as events from './events.js';
import * as generate from './generate.js';
import * as refine from './refine.js';
import * as edit from './edit.js';
import * as judge from './judge.js';
import * as reverse from './reverse.js';
import * as session from './session.js';
import * as choice from './choice.js';
import * as test from './test.js';

export function registerRoutes(app: Application) {
  events.register(app);
  generate.register(app);
  refine.register(app);
  edit.register(app);
  judge.register(app);
  reverse.register(app);
  session.register(app);
  choice.register(app);
  test.register(app);
}
