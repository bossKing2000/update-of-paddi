import { Request, Response } from 'express';
import { runSeeder, stopSeeder, getSeederStatus } from '../jobs/seed';

export const startSeeder = (_req: Request, res: Response) => {
  try {
    const started = runSeeder();
    if (!started) return res.json({ message: 'Seeder already running' });
    return res.json({ message: 'Seeder started' });
  } catch (err: any) {
    console.error('Failed to start seeder:', err);
    return res.status(500).json({ message: 'Failed to start seeder', error: err?.message || err });
  }
};

export const requestStopSeeder = (_req: Request, res: Response) => {
  try {
    const stopped = stopSeeder();
    if (!stopped) return res.json({ message: 'Seeder is not running' });
    return res.json({ message: 'Stop requested' });
  } catch (err: any) {
    console.error('Failed to request stop:', err);
    return res.status(500).json({ message: 'Failed to request stop', error: err?.message || err });
  }
};

export const seederProgress = (_req: Request, res: Response) => {
  try {
    const status = getSeederStatus();
    return res.json(status);
  } catch (err: any) {
    console.error('Failed to get seeder status:', err);
    return res.status(500).json({ message: 'Failed to get seeder status', error: err?.message || err });
  }
};
