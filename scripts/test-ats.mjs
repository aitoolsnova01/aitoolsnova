#!/usr/bin/env node
/**
 * Offline tests for js/ats-checker.js (the ATS Resume Checker engine).
 * No network, no API keys. Guards the scoring heuristics from regressing.
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ATS = require('../js/ats-checker.js');

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
    ok ? pass++ : fail++;
    console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
};

const GOOD = [
    'John Doe', 'john@example.com', '+91 98765 43210', 'linkedin.com/in/johndoe',
    'PROFESSIONAL SUMMARY', 'Results-driven engineer with 5 years building web platforms.',
    'WORK EXPERIENCE',
    '- Led a team of 5 and increased revenue 30% by launching a new checkout flow.',
    '- Reduced infra cost 22% by automating deployments with Docker, Kubernetes and CI/CD pipelines.',
    'EDUCATION', 'B.Tech Computer Science, ABC University (2016-2020)',
    'SKILLS', 'JavaScript, React, Python, AWS, Docker, SQL, communication, project management'
].join('\n');

const JD = 'We need a developer with JavaScript, React, Python, AWS, Docker, SQL and strong communication. Must have Kubernetes and CI/CD.';

const BAD = 'I am a hard working person. I like to work. References available on request. 🙂';

const good = ATS.analyze(GOOD, JD);
const bad = ATS.analyze(BAD, '');

check('good resume scores > 70', good.score > 70, `score=${good.score}`);
check('bad resume scores < 40', bad.score < 40, `score=${bad.score}`);
check('good resume has zero missing JD keywords', good.missingKeywords.length === 0, good.missingKeywords.join(','));
check('detects email+phone on good', good.categories[0].got >= 13, `contact=${good.categories[0].got}`);
check('bad resume flags suggestions', bad.suggestions.length >= 5, `${bad.suggestions.length} suggestions`);

// Token-boundary matching: "java" must NOT match inside "javascript".
const j = ATS.analyze('SKILLS\njavascript', 'Need Java and JavaScript');
check('"java" not matched by "javascript"', j.missingKeywords.includes('java'), JSON.stringify(j.missingKeywords));
check('"javascript" matched', j.matchedKeywords.includes('javascript'), j.matchedKeywords.join(','));

// Sections detection
check('detects all 4 standard sections on good', good.categories[1].got === 20, `sections=${good.categories[1].got}`);

console.log(`\n${pass} passed / ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
