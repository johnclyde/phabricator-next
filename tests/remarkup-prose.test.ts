import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DiscussionBody, LazyRemarkupBody, RemarkupBody, type RemarkupBodyProps } from '../client/Remarkup.tsx';

test('discussion wrapper retains existing source controls and content classes', () => {
  const html = renderToStaticMarkup(createElement(DiscussionBody, { body: '**Discussion**', className: 'task-comment-body' }));
  assert.match(html, /^<div class="discussion-body"><div class="remarkup-content task-comment-body"><p><strong>Discussion<\/strong><\/p>/);
  assert.match(html, /<summary>Source<\/summary>/);
  assert.match(html, /aria-label="Exact comment source">\*\*Discussion\*\*<\/pre>/);
  assert.match(html, /type="button">Copy Source<\/button>/);
  assert.doesNotMatch(html, /Source text/);
});

test('prose source labels and layout classes belong to the selected field', () => {
  const html = renderToStaticMarkup(createElement(RemarkupBody, {
    body: '**Current summary**', className: 'revision-summary-reader', contentClassName: 'revision-metadata-text',
    contextKey: 'D42:metadata:5', sourceLabel: 'Exact revision summary source', sourceSummary: 'Summary source', fallbackNoun: 'summary',
  }));
  assert.match(html, /^<div class="remarkup-body revision-summary-reader"><div class="remarkup-content revision-metadata-text">/);
  assert.match(html, /<strong>Current summary<\/strong>/);
  assert.match(html, /<summary>Summary source<\/summary>/);
  assert.match(html, /aria-label="Exact revision summary source">\*\*Current summary\*\*<\/pre>/);
  assert.doesNotMatch(html, /comment|discussion-body/);
});

test('empty prose remains exact and default source disclosure does not shadow Source view controls', () => {
  const html = renderToStaticMarkup(createElement(RemarkupBody, { body: '' }));
  assert.match(html, /<div class="remarkup-content"><\/div>/);
  assert.match(html, /<summary>Source text<\/summary>/);
  assert.match(html, /aria-label="Exact source"><\/pre>/);
  assert.doesNotMatch(html, /No description|No summary|<summary>Source<\/summary>/);
});

test('closed task disclosures do not mount a reader or include concealed source', () => {
  const body = '**Do not parse until opened**\n\n[[ https://example.test | Example ]]';
  const html = renderToStaticMarkup(createElement(LazyRemarkupBody, {
    body, contextKey: 'T1:7', disclosureClassName: 'task-description', className: 'task-list-description',
    summary: 'Description', sourceLabel: 'Exact task description source',
  }));
  assert.equal(html, '<details class="task-description"><summary>Description</summary></details>');
});

// This boundary is deliberate: prose does not carry immutable discussion
// bindings, so integrations cannot accidentally opt it into people rendering.
const prooflessProps: RemarkupBodyProps = {
  body: '@reader',
  // @ts-expect-error Saved mention evidence belongs only to DiscussionBody.
  mentions: undefined,
};
void prooflessProps;
