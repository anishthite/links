import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../src/agent-view';

describe('renderMarkdown', () => {
  it('renders common markdown while escaping raw html', () => {
    const html = renderMarkdown('## Plan\n- **ship** `code`\n\n```ts\n<script>bad()</script>\n```');

    expect(html).toContain('<h2>Plan</h2>');
    expect(html).toContain('<li><strong>ship</strong> <code>code</code></li>');
    expect(html).toContain('&lt;script&gt;bad()&lt;/script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('renders horizontal rules and gfm tables', () => {
    const html = renderMarkdown('---\n\n| Idea | What it optimizes |\n| --- | --- |\n| Board | Personal infrastructure |\n| AI bookmarking | Possibly a product |');

    expect(html).toContain('<hr class="agent-md-rule">');
    expect(html).toContain('<table class="agent-md-table">');
    expect(html).toContain('<th>Idea</th>');
    expect(html).toContain('<td>Board</td>');
  });

  it('renders note citations as inline source buttons', () => {
    const html = renderMarkdown('This came from [#2].');

    expect(html).toContain('class="agent-cite"');
    expect(html).toContain('data-source-ref="1"');
  });
});
