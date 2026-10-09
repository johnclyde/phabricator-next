import type { Finding, ReviewAnalysis, RevisionKind, SourceFile } from './types';

// Intentionally portable: the exact same checks run in the browser, CLI and server.
// These are conservative text checks, not a compiler, proof verifier or AI model.
export function analyzeLocally(kind: RevisionKind, files: SourceFile[]): ReviewAnalysis {
  const findings: Finding[] = [];
  const add = (file: SourceFile, line: number, severity: Finding['severity'], title: string, body: string) => {
    findings.push({ id: `local-${findings.length + 1}`, severity, filePath: file.path, line, title, body, source: 'local' });
  };
  for (const file of files) {
    file.content.split('\n').forEach((text, i) => {
      // An isolated ======= line is also a valid Markdown Setext heading.
      // Conflict start/end markers remain blockers, including incomplete blocks.
      if (/^(?:<{7}|>{7})(?: |$)/.test(text)) {
        add(file, i + 1, 'error', 'Unresolved merge marker', 'Resolve the merge conflict before accepting this version.');
      }
      if (/\b(?:TODO|FIXME)\b|\\todo\s*\{/.test(text)) {
        add(file, i + 1, 'warning', 'Unfinished work', 'This line contains an explicit unfinished-work marker. Decide whether it must be resolved before acceptance.');
      }
      if (kind === 'code' && /\b(?:eval\s*\(|new\s+Function\s*\()/.test(text) && !/^\s*(?:\/\/|\*|#)/.test(text)) {
        add(file, i + 1, 'warning', 'Dynamic code execution', 'Review the origin of this input. This text check cannot determine whether the input is trusted.');
      }
      if (kind === 'code' && /\b(?:password|api[_-]?key|secret|access[_-]?token)\s*[:=]\s*['"][^'"]{8,}['"]/i.test(text)) {
        add(file, i + 1, 'warning', 'Possible embedded credential', 'Inspect this string assignment and move real credentials out of source control. The value is not copied into this finding.');
      }
    });
  }
  if (kind === 'document') {
    for (const file of files) file.content.split('\n').forEach((text, i) => {
      if (/\[(?:citation needed|insert[^\]]*|authority needed|name|date)\]/i.test(text)) {
        add(file, i + 1, 'warning', 'Unresolved drafting placeholder', 'Replace this placeholder with supported text. This check does not verify authorities or legal sufficiency.');
      }
    });
  }
  if (kind === 'paper' || (kind === 'document' && files.some(file => /\.tex$/i.test(file.path)))) {
    const tex = files.filter(file => /\.tex$/i.test(file.path));
    const clean = tex.map(file => ({ file, lines: file.content.split('\n').map(stripTexComment) }));
    const labels = new Set<string>();
    const citations = new Set<string>();
    for (const file of files.filter(file => /\.bib$/i.test(file.path))) {
      for (const match of file.content.matchAll(/@(?!(?:comment|string|preamble)\b)\w+\s*\{\s*([^,\s]+)\s*,/gi)) citations.add(match[1]);
    }
    for (const { file, lines } of clean) {
      lines.forEach((text, i) => {
        for (const match of text.matchAll(/\\label\s*\{([^}]+)\}/g)) {
          if (labels.has(match[1])) add(file, i + 1, 'error', 'Duplicate label', `The label “${match[1]}” is defined more than once in this snapshot.`);
          labels.add(match[1]);
        }
        for (const match of text.matchAll(/\\bibitem(?:\[[^\]]*\])?\s*\{([^}]+)\}/g)) citations.add(match[1]);
      });
    }
    for (const { file, lines } of clean) {
      lines.forEach((text, i) => {
        for (const match of text.matchAll(/\\(?:ref|eqref|autoref|cref|Cref|pageref)\*?\s*\{([^}]+)\}/g)) {
          for (const label of match[1].split(',').map(value => value.trim())) {
            if (!labels.has(label)) add(file, i + 1, 'warning', 'Unresolved reference', `No definition of “${label}” was found among the supplied .tex files. Macro-generated or external labels are not resolved by this check.`);
          }
        }
        for (const match of text.matchAll(/\\(?:cite|citep|citet|parencite|textcite|autocite|nocite)\*?(?:\[[^\]]*\]){0,2}\s*\{([^}]+)\}/g)) {
          for (const key of match[1].split(',').map(value => value.trim())) {
            if (key !== '*' && !citations.has(key)) add(file, i + 1, 'warning', 'Unresolved citation', `No bibliography entry for “${key}” was found in this snapshot. Include the corresponding .bib file or bibitem.`);
          }
        }
        if (/\\(?:write18|immediate\s*\\write18)\b/.test(text)) {
          add(file, i + 1, 'error', 'Shell escape in manuscript', 'This source requests shell execution. Remove it before sending the manuscript to a build worker.');
        }
      });
    }
    if (tex.length === 0 && files.length > 0) add(files[0], 1, 'warning', 'No LaTeX source', 'Add a .tex file to enable manuscript checks.');
    const combined = clean.map(item => item.lines.join('\n')).join('\n');
    if (tex.length > 0 && !/\\begin\s*\{abstract\}|\\abstract\s*\{/.test(combined)) {
      add(tex[0], 1, 'info', 'No abstract detected', 'No conventional abstract environment or command was found. Your document class may use another form.');
    }
  }
  const errors = findings.filter(finding => finding.severity === 'error').length;
  const warnings = findings.filter(finding => finding.severity === 'warning').length;
  return {
    provider: 'local', model: 'text-checks-v1', findings,
    summary: `Local text checks completed for ${files.length} file${files.length === 1 ? '' : 's'}: ${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}. ${kind === 'paper' ? 'References and bibliography keys checked within this snapshot; scientific claims and proofs are not verified.' : kind === 'document' ? 'Drafting markers checked; factual claims, legal authorities and legal sufficiency are not verified.' : 'These checks do not compile code, run tests, or establish correctness.'}`,
  };
}

function stripTexComment(line: string): string {
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== '%') continue;
    let slashes = 0;
    for (let j = i - 1; j >= 0 && line[j] === '\\'; j--) slashes++;
    if (slashes % 2 === 0) return line.slice(0, i);
  }
  return line;
}
