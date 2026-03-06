import os from 'node:os';
import path from 'node:path';
import { createProfileStore } from './profile-store.js';
import { WorkstationSnapshotSchema } from '../schemas/config.js';

const SNAPSHOTS_DIR = path.join(os.homedir(), '.clawdult', 'workstation-snapshots');

const store = createProfileStore(SNAPSHOTS_DIR, WorkstationSnapshotSchema);

export const listSnapshots = store.list;
export const getSnapshot = store.get;
export const saveSnapshot = store.save;
export const deleteSnapshot = store.delete;
