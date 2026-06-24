// Fallback notes used when no /api/notes endpoint is reachable (i.e. `vite dev`
// without `wrangler pages dev`). Same eight notes as themes/02e-bg.html so dev
// mode matches the locked design spec visually.

import type { Note } from './types';

const t = (iso: string) => new Date(iso).getTime();

export const SAMPLE_NOTES: Note[] = [
  { uuid:'a1', text:'buy bok choy', tags:['todo','shop'], color:null,
    createdAt:t('2026-05-22T18:04:00Z'), updatedAt:t('2026-05-22T18:04:00Z') },
  { uuid:'b2', text:'idea: sticky note board with masonry layout via pretext', tags:['idea','board'], color:null,
    createdAt:t('2026-05-22T15:31:00Z'), updatedAt:t('2026-05-22T15:31:00Z') },
  { uuid:'c3', text:'the difference between vision and hallucination is whether other people can see it too', tags:['thought'], color:null,
    createdAt:t('2026-05-21T22:11:00Z'), updatedAt:t('2026-05-21T22:11:00Z') },
  { uuid:'d4', text:'todo: ssh into the new box, set up tailscale, install zellij', tags:['todo','infra'], color:null,
    createdAt:t('2026-05-21T09:47:00Z'), updatedAt:t('2026-05-21T09:47:00Z') },
  { uuid:'e5', text:"today's lesson — pretext is a library not a framework. you render with whatever.", tags:['lesson'], color:null,
    createdAt:t('2026-05-20T16:22:00Z'), updatedAt:t('2026-05-20T16:22:00Z') },
  { uuid:'f6', text:'jamie birthday march 14', tags:['reminder','people'], color:null,
    createdAt:t('2026-05-19T11:00:00Z'), updatedAt:t('2026-05-19T11:00:00Z') },
  { uuid:'g7', text:'the way to import 40 thousand art hoes to SF to teach engineers love (and thus save humankind) would be to open an elite fashion school. considering the materials science infrastructure this is actually the obvious path forward for fashion.', tags:['idea','hot-take'], color:null,
    createdAt:t('2026-05-18T03:14:00Z'), updatedAt:t('2026-05-18T03:14:00Z') },
  { uuid:'h8', text:'every infra choice is a bet on who you will be in two years', tags:['thought','infra'], color:null,
    createdAt:t('2026-05-17T08:00:00Z'), updatedAt:t('2026-05-17T08:00:00Z') },
];
