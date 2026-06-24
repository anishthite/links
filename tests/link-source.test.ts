import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildLinkNoteInsert, normalizeSourceUrl } from '../server/lib/link-source';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('link source extraction', () => {
  it('normalizes tracking params off YouTube URLs', () => {
    expect(normalizeSourceUrl('https://www.youtube.com/watch?v=abc123&utm_source=test&fbclid=123')).toBe('https://www.youtube.com/watch?v=abc123');
  });

  it('stores YouTube transcript text when captions exist', async () => {
    const watchHtml = `
      <html>
        <head><title>Ignored title</title></head>
        <body>
          <script>
            var ytInitialPlayerResponse = {
              "videoDetails": {
                "title": "How to Setup a Local Coding Agent on macOS",
                "author": "Kyle Howells",
                "shortDescription": "Practical guide"
              },
              "captions": {
                "playerCaptionsTracklistRenderer": {
                  "captionTracks": [
                    {"baseUrl":"https://www.youtube.com/api/timedtext?v=abc&lang=en&fmt=srv3","languageCode":"en","kind":"asr"}
                  ]
                }
              }
            };
          </script>
        </body>
      </html>
    `;
    const transcript = {
      events: [
        { segs: [{ utf8: 'Hello ' }, { utf8: 'world' }] },
        { segs: [{ utf8: 'Agents can read transcripts.' }] },
      ],
    };

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(watchHtml, { status: 200, headers: { 'content-type': 'text/html' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(transcript), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const row = await buildLinkNoteInsert({ sourceUrl: 'https://www.youtube.com/watch?v=abc', text: '', tags: [] });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('fmt=json3');
    expect(row.sourceTitle).toBe('How to Setup a Local Coding Agent on macOS');
    expect(row.sourceAuthor).toBe('Kyle Howells');
    expect(row.sourceSiteName).toBe('YouTube');
    expect(row.sourceDescription).toBe('Practical guide');
    expect(row.sourceContentText).toContain('Hello world');
    expect(row.sourceContentText).toContain('Agents can read transcripts.');
    expect(row.text).toContain('How to Setup a Local Coding Agent on macOS');
  });
});
