// 이 스크립트는 GitHub Actions가 화/수/목 오전 9시(KST)에 자동으로 실행합니다.
//
// [왜 단계를 나눴나] 한 번에 "검색+정리+JSON 작성"을 시키면 아래 문제가 반복됐습니다.
//   - 지난번 카드를 고쳐 쓰다가 틀린 내용(이미 바뀐 인선 상황, 수치)이 그대로 이월됨
//   - 2024·2025년 기사가 2026년 것처럼 섞여 들어옴
//   - 기사 "제목"만 보고 내용을 추정함 (본문을 못 읽은 채로 사실처럼 씀)
//   - 요일·날짜 계산 실수, 존재하지 않는 URL, 주장과 무관한 출처 링크
// 그래서 (1) 카테고리별 리서치 → (2) 근거만으로 카드 작성 → (3) 별도 검증 → (4) 코드 검증 순으로
// 나눴고, 날짜·요일·URL은 모델의 기억이 아니라 "코드"가 직접 확인합니다.
//
// 손으로 내용을 고치고 싶을 땐 이 파일이 아니라 data.json을 직접 편집하면 됩니다.
// (단, 다음 자동 실행 때 새로 덮어써집니다.)

const fs = require('fs');

const MODEL = process.env.RADAR_MODEL || 'claude-sonnet-5';
const API_KEY = process.env.ANTHROPIC_API_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY || '';
const TIP_ISSUE_LABEL = 'radar-tips';

// ------------------------------------------------------------
// 0) 날짜 도구 — 요일/기간 계산은 모델에게 맡기지 않고 코드가 합니다.
// ------------------------------------------------------------
const DOW = ['일', '월', '화', '수', '목', '금', '토'];
const kstParts = (d) => {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(d).split('-').map(Number);
  return { y: p[0], m: p[1], d: p[2] };
};
const dowOf = (y, m, d) => DOW[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];

function buildCalendar(now, days = 42) {
  const t = kstParts(now);
  const base = Date.UTC(t.y, t.m - 1, t.d);
  const rows = [];
  for (let i = 0; i < days; i++) {
    const dt = new Date(base + i * 86400000);
    const y = dt.getUTCFullYear(), m = dt.getUTCMonth() + 1, d = dt.getUTCDate();
    rows.push(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')} = ${m}.${d}(${DOW[dt.getUTCDay()]})`);
  }
  return rows.join('\n');
}

// 텍스트 안의 "10.7(수)" 같은 표기가 실제 요일과 맞는지 확인하고 틀리면 고칩니다.
function fixWeekdays(text, refYear, report, where) {
  if (typeof text !== 'string') return text;
  return text.replace(/(\d{1,2})\.(\d{1,2})\s*\(([월화수목금토일])\)/g, (full, mm, dd, wd) => {
    const m = Number(mm), d = Number(dd);
    if (m < 1 || m > 12 || d < 1 || d > 31) return full;
    const real = dowOf(refYear, m, d);
    if (real !== wd) {
      report.weekdayFixes.push(`${where}: ${m}.${d}(${wd}) → ${m}.${d}(${real})`);
      return `${m}.${d}(${real})`;
    }
    return full;
  });
}

// ------------------------------------------------------------
// 1) Anthropic API 호출 도구 (웹 검색 중간 중단 처리 + 실제 검색된 URL 수집)
// ------------------------------------------------------------
const seenUrls = new Map(); // url -> {title, page_age}
const normUrl = (u) => String(u || '').trim().replace(/#.*$/, '').replace(/\/+$/, '');

function collectUrls(blocks) {
  for (const b of blocks || []) {
    if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) {
      b.content.forEach(r => r && r.url && seenUrls.set(normUrl(r.url), { title: r.title, page_age: r.page_age }));
    }
    if (b.type === 'web_fetch_tool_result' && b.content && b.content.url) {
      seenUrls.set(normUrl(b.content.url), { title: '', page_age: null, fetched: true });
    }
  }
}

async function callClaude({ prompt, tools, maxTokens = 8000, betaHeaders = [] }) {
  const messages = [{ role: 'user', content: prompt }];
  let allText = '';
  for (let turn = 0; turn < 8; turn++) {
    const headers = {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01'
    };
    if (betaHeaders.length) headers['anthropic-beta'] = betaHeaders.join(',');
    const body = { model: MODEL, max_tokens: maxTokens, messages };
    if (tools && tools.length) body.tools = tools;

    const res = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`Anthropic API 오류 (${res.status}): ${await res.text()}`);
    const data = await res.json();
    collectUrls(data.content);
    allText += (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n') + '\n';

    if (data.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: data.content });
      continue; // 검색이 길어져 잠시 멈춘 경우 이어서 진행
    }
    break;
  }
  return allText.trim();
}

function extractJson(text, open = '{', close = '}') {
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '');
  const s = cleaned.indexOf(open), e = cleaned.lastIndexOf(close);
  if (s === -1 || e === -1 || e < s) return null;
  try { return JSON.parse(cleaned.slice(s, e + 1)); } catch (err) { return null; }
}

const SEARCH_TOOLS = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 12 }];
// 기사 "본문"을 읽을 수 있는 도구(베타). 지원되지 않으면 검색만으로 자동 대체합니다.
const FETCH_TOOL = { type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 8 };
const FETCH_BETA = ['web-fetch-2025-09-10'];

async function callWithResearchTools(args) {
  try {
    return await callClaude({ ...args, tools: [...SEARCH_TOOLS, FETCH_TOOL], betaHeaders: FETCH_BETA });
  } catch (e) {
    if (/400|tool|beta/i.test(e.message)) {
      console.warn('[안내] 본문 읽기(web_fetch) 도구를 쓸 수 없어 검색만으로 진행합니다:', e.message.slice(0, 120));
      return await callClaude({ ...args, tools: SEARCH_TOOLS });
    }
    throw e;
  }
}

// ------------------------------------------------------------
// 2) 담당자 제보 / 지난 업데이트
// ------------------------------------------------------------
async function fetchTipComments() {
  if (!GITHUB_TOKEN || !GITHUB_REPOSITORY) return '(제보 채널 정보를 확인할 수 없어 이번엔 건너뜁니다)';
  const gh = { 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json', 'User-Agent': 'policy-radar-bot' };
  try {
    const r = await fetch(`https://api.github.com/repos/${GITHUB_REPOSITORY}/issues?labels=${TIP_ISSUE_LABEL}&state=open`, { headers: gh });
    if (!r.ok) return '(제보 이슈를 찾지 못했습니다 — 아직 만들지 않았다면 정상입니다)';
    const issues = await r.json();
    if (!Array.isArray(issues) || !issues.length) return '(현재 등록된 제보가 없습니다)';
    const out = [];
    for (const issue of issues) {
      const cr = await fetch(`https://api.github.com/repos/${GITHUB_REPOSITORY}/issues/${issue.number}/comments`, { headers: gh });
      if (!cr.ok) continue;
      (await cr.json()).forEach(c => out.push(`- (${(c.created_at || '').slice(0, 10)}, ${(c.user && c.user.login) || '익명'}) ${c.body.trim()}`));
    }
    return out.length ? out.join('\n') : '(현재 등록된 제보가 없습니다)';
  } catch (e) {
    return '(제보를 불러오는 중 오류: ' + e.message + ')';
  }
}

function readPrevious() {
  try {
    const prev = JSON.parse(fs.readFileSync('data.json', 'utf-8'));
    const topics = [];
    (prev.weeks || []).forEach(w => (w.cards || []).forEach(c => topics.push(`- ${c.title}`)));
    return { generatedAt: prev.generated_at || null, topics: topics.join('\n') || '(없음)', raw: prev };
  } catch (e) {
    return { generatedAt: null, topics: '(이전 데이터 없음)', raw: null };
  }
}

// ------------------------------------------------------------
// 3) 1단계 — 리서치 (카테고리별로 따로 검색해서 "근거 목록"만 만듭니다)
// ------------------------------------------------------------
const CATEGORIES = [
  { id: 'a1', name: '국회 일정', hint: '국정감사(상임위별 날짜·증인·핵심 쟁점·종합감사), 본회의(상정 법안·처리 예정 쟁점법안), 인사청문회, 대정부질문, 예산·법안 처리 일정' },
  { id: 'a2', name: '청와대·정부 일정', hint: '대통령 대외 일정(순방·정상회담), 국무회의, 부처별 이번 주·다음 주 주요 일정, 정부 발표 예정 정책(부동산·경제·복지 등), 인사(비서실장·장관 등) 상황' },
  { id: 'b', name: '이익단체·시민단체·노조 행동', hint: '총파업 예고, 직능단체 궐기대회, 농민·의료·교육 단체 집회, 피해자 모임 항의 행동, 경찰 집회 신고·공지 현황' },
  { id: 'c', name: '정당 행사', hint: '국민의힘·민주당·조국혁신당·개혁신당 등의 장외집회, 보고대회, 연찬회, 당 지도부 일정, 특검 등 정국 쟁점 대응' },
  { id: 'd1', name: '기념일·확정 예정 일정', hint: '국경일·기념일·참사 주기, 북한 기념일, 거래소·부처 정례 공표일, 제도 시행일, 발사·개장 등 날짜 확정 이벤트' },
  { id: 'd2', name: '사회 이슈 동향', hint: '최근 1~2주 사이 새로 불거진 사건·사고·논란(영화·입시·의료·물가·부동산·금융 등), 여론조사(조사기관·조사일·표본·수치 정확히), 후속 조치 일정' },
  { id: 'tips', name: '담당자 제보 교차확인', hint: '아래 제보 내용을 하나씩 검색으로 확인' }
];

function researchPrompt(cat, ctx) {
  return `오늘은 ${ctx.todayKST}(한국시간)이고, 연도는 ${ctx.year}년입니다.

[날짜표 — 요일은 반드시 이 표를 따르세요. 직접 계산하지 마세요]
${ctx.calendar}

당신은 정책 커뮤니케이션 담당자를 위한 사실 조사원입니다. 지금 임무: 「${cat.name}」.
조사 대상: ${cat.hint}
조사 기간: 오늘부터 약 5주(${ctx.windowLabel}). 단, 최근 1~2주 사이 벌어진 사건의 "진행 상황"도 함께 조사.

${cat.id === 'tips' ? `[담당자 제보 — 미확인 메모. 그대로 믿지 말고 검색으로 확인]\n${ctx.tips}\n` : ''}
[이전 판에 있던 주제 — 내용을 믿지 말고 "지금 어떻게 됐는지"만 새로 확인. 관련 있는 것만]
${ctx.previousTopics}

[엄격한 규칙]
1. 검색어에 반드시 "${ctx.year}년 ${ctx.month}월" 같은 연·월을 넣고, 검색어를 바꿔 최소 4회 이상 검색하세요. 일반적 검색 1회로 끝내지 마세요.
2. 검색 결과의 "제목·요약"만 보고 사실을 쓰지 마세요. 핵심 기사는 본문을 읽어(가능한 경우) 확인하세요. 본문을 못 읽었다면 evidence_level을 "headline_only"로 표시.
3. 기사의 "발행일"을 반드시 확인해 article_date에 적으세요(YYYY-MM-DD). 발행일을 모르거나 ${ctx.year}년이 아닌 기사(작년·재작년 보도)는 쓰지 마세요. 제목에 같은 사건명이 있어도 연도가 다르면 다른 사건입니다.
4. 일정의 날짜는 기사에 적힌 그대로(연·월·일, 시각, 장소, 소관 기관)를 적고, "예정/진행 중/완료/연기/취소 여부"를 status에 적으세요. 이미 지난 일정은 "완료"로, 결과가 아직 보도되지 않았으면 "결과 미확인"으로.
5. 수치(지지율·피해액·인원 등)는 기사가 직접 인용한 수치만 쓰고, 출처가 "야당 주장"·"여당 주장"·"정부 발표"인지 attributed_to에 적으세요. 확인 안 되는 수치는 넣지 마세요.
6. 기억·추정으로 채우지 마세요. 못 찾았으면 "찾지 못함"이라고 적는 것이 정답입니다.
7. url은 이번 검색에서 실제로 열람/검색된 주소만 쓰세요.

출력은 아래 형식의 JSON 배열 "하나만" (다른 말·코드펜스 금지). 항목은 8~20개:
[
  {
    "topic": "한 줄 주제",
    "event_date_text": "기사에 적힌 일정 표현 (예: 10월 15일 목요일 오후 2시 서울 여의도)",
    "event_date_iso": "YYYY-MM-DD 또는 null(미정)",
    "status": "예정 | 진행 중 | 완료 | 결과 미확인 | 연기 | 취소 | 날짜 미정",
    "details": "시각·장소·기관·위원회·안건·참석자 등 구체 사실",
    "media_trend": "최근 보도·여론 흐름 (인용 수치는 attributed_to 포함)",
    "attributed_to": "수치·주장의 주체 또는 null",
    "evidence_level": "full_article | headline_only",
    "sources": [ { "label": "언론사", "url": "...", "article_date": "YYYY-MM-DD" } ]
  }
]`;
}

async function runResearch(ctx) {
  const findings = [];
  const gaps = [];
  for (const cat of CATEGORIES) {
    if (cat.id === 'tips' && /^\(/.test(ctx.tips)) continue; // 제보가 없으면 건너뜀
    console.log(`[1단계] 조사 중: ${cat.name}`);
    try {
      const text = await callWithResearchTools({ prompt: researchPrompt(cat, ctx), maxTokens: 8000 });
      const arr = extractJson(text, '[', ']');
      if (!Array.isArray(arr)) { gaps.push(`${cat.name}: 결과를 읽지 못함`); continue; }
      arr.forEach(f => { f._cat = cat.id; findings.push(f); });
    } catch (e) {
      gaps.push(`${cat.name}: ${e.message.slice(0, 120)}`);
    }
  }
  return { findings, gaps };
}

// ------------------------------------------------------------
// 4) 2단계 — 카드 작성 (검색 없이, 1단계 근거만 사용)
// ------------------------------------------------------------
const CARD_SCHEMA = `{
  "generated_at": "(코드가 채움 — 비워두세요)",
  "range_label": "예: 10.7(수) – 11.2(월)",
  "weeks": [
    { "label": "예: 10월 셋째주", "range": "10.12(월) – 10.18(일)", "note": "한두 문장 요약",
      "cards": [
        { "day": "날짜·요일 또는 '날짜 미정 · ~~'", "severity": "risk|caution|watch", "sevLabel": "위험|주의|모니터링",
          "title": "한 줄 제목",
          "schedule": "시간·장소·기관·진행 방식까지. 근거에 없는 시각·장소는 쓰지 말 것",
          "trend": "근거에 있는 보도·여론만. 수치는 주체(야당 주장 등) 병기",
          "outlook": "전망. 이전 판과 달라진 점은 '(지난 업데이트 대비: ~~)'",
          "action": "담당자 체크포인트",
          "confidence": "확인됨 | 보도 기준 | 제보·미확인 | 재확인 필요",
          "sources": [ { "label": "언론사", "url": "근거 목록에 있는 URL만" } ] } ] } ]
}`;

function composePrompt(ctx, findings) {
  return `오늘은 ${ctx.todayKST}(한국시간)입니다. 아래 "근거 목록"만 사용해 정책 레이더 카드를 작성하세요.

[날짜표 — 요일은 이 표를 따르세요]
${ctx.calendar}

[작성 규칙]
- 근거 목록에 없는 사실·수치·날짜·시각·장소는 쓰지 마세요. 기억으로 보충 금지.
- 이전 판의 문구를 복사하지 마세요. 이전 판 주제는 근거 목록에 새로운 확인이 있을 때만 포함합니다. 새 확인이 없으면 제외하거나 confidence를 "재확인 필요"로 하고 schedule에 "이번 조사에서 재확인하지 못함"이라고 적으세요.
- evidence_level이 headline_only인 항목은 confidence를 "보도 기준"으로 하고, 세부 내용을 단정하지 마세요.
- status가 "완료"인 일정은 "~일 완료"로 쓰고 결과가 미확인이면 "결과 미확인"이라고 명시하세요. 이미 지난 일정을 "예정"으로 쓰지 마세요.
- event_date_iso가 5주 밖이면 제외, 5주 안인데 주차가 없으면 주차를 추가하세요. 주차 경계는 월~일입니다.
- 이번 주에는 오늘 이전에 끝난 일정도 맥락상 중요하면 포함하되 day에 "완료"를 명시하세요.
- 제보 기반이면 schedule 끝에 "(담당자 제보 기반, 공식 확인 필요)"를 붙이고 confidence는 "제보·미확인".
- 수치는 attributed_to를 병기하세요(예: "국민의힘 주장").
- 정당·정치인에 대한 개인 견해 금지. 위험도: risk=즉각 평판·소통 리스크, caution=관리 필요 절차·논쟁, watch=일정 확인 수준.
- sources.url은 근거 목록의 url 중에서만 고르세요.

[근거 목록 JSON]
${JSON.stringify(findings)}

[출력] 아래 스키마의 JSON 객체 하나만 (설명·코드펜스 금지):
${CARD_SCHEMA}`;
}

// ------------------------------------------------------------
// 5) 3단계 — 독립 검증 (다른 시각에서 의심하며 재확인)
// ------------------------------------------------------------
function verifyPrompt(ctx, draft) {
  return `오늘은 ${ctx.todayKST}(한국시간)입니다. 당신은 "팩트체크 담당 검증자"입니다. 아래 초안을 처음 보는 사람처럼 의심하며 검증하세요.

[날짜표]
${ctx.calendar}

[검증 항목 — 카드마다 모두 수행]
1. 날짜·요일: 날짜표와 일치하는가? 이미 지난 일정을 "예정"으로 쓰지 않았는가?
2. 사건의 연도: ${ctx.year - 1}년 이전 사건과 섞이지 않았는가? (같은 이름의 작년 사건 주의)
3. 핵심 수치·고유명사·직함: 출처 기사에 실제로 있는가? 웹 검색/본문 열람으로 확인하세요. 카드마다 최소 1회 검색하고, severity가 risk인 카드는 핵심 주장 2개 이상 확인하세요.
4. 출처 링크: 그 링크가 해당 주장을 뒷받침하는가? (제목만 비슷한 무관한 기사는 제거)
5. 확인 불가 항목: 수치는 삭제하거나 "보도 기준(미확인)"으로 약화, 사실 자체가 확인되지 않으면 카드 삭제.

[규칙]
- 고칠 때는 검색으로 확인한 내용만 사용. 새 URL은 이번 검색에서 열람한 것만.
- 카드의 confidence를 검증 결과에 맞게 갱신 ("확인됨"은 2개 이상 독립 출처 또는 공식 발표로 확인된 경우에만).
- 출력은 수정된 전체 JSON 객체(초안과 동일 스키마) 하나만, 그리고 객체 최상단에 "verification_log": ["수정·삭제한 내용 요약", ...] 배열을 추가하세요. 설명·코드펜스 금지.

[초안]
${JSON.stringify(draft)}`;
}

// ------------------------------------------------------------
// 6) 4단계 — 코드 검증 (모델이 아닌 규칙으로 확인)
// ------------------------------------------------------------
function codeValidate(parsed, ctx) {
  const report = { weekdayFixes: [], droppedSources: [], notes: [] };

  (parsed.weeks || []).forEach((w, wi) => {
    ['label', 'range', 'note'].forEach(k => { w[k] = fixWeekdays(w[k], ctx.year, report, `week${wi + 1}.${k}`); });
    (w.cards || []).forEach((c, ci) => {
      const where = `week${wi + 1}.card${ci + 1}`;
      ['day', 'title', 'schedule', 'trend', 'outlook', 'action'].forEach(k => { c[k] = fixWeekdays(c[k], ctx.year, report, `${where}.${k}`); });

      // 출처: 이번 실행에서 실제로 검색/열람된 URL만 남김 + URL 속 날짜(연도) 점검
      const kept = [];
      (c.sources || []).forEach(s => {
        const u = normUrl(s && s.url);
        if (!u) return;
        if (!seenUrls.has(u)) { report.droppedSources.push(`${where}: 이번 검색에 없던 URL 제거 (${u})`); return; }
        const m = u.match(/(20\d{2})[\/\-_]?(0[1-9]|1[0-2])[\/\-_]?([0-2]\d|3[01])/);
        if (m && Number(m[1]) < ctx.year) { report.droppedSources.push(`${where}: ${m[1]}년 기사로 보여 제거 (${u})`); return; }
        kept.push(s);
      });
      c.sources = kept;
      if (!kept.length && c.confidence !== '제보·미확인') {
        c.confidence = '재확인 필요';
        report.notes.push(`${where}: 유효한 출처 없음 → "재확인 필요"로 표시 (${c.title})`);
      }
      if (!['확인됨', '보도 기준', '제보·미확인', '재확인 필요'].includes(c.confidence)) c.confidence = '보도 기준';
      if (!['risk', 'caution', 'watch'].includes(c.severity)) c.severity = 'watch';
      c.sevLabel = { risk: '위험', caution: '주의', watch: '모니터링' }[c.severity];
    });
  });
  return report;
}

// ------------------------------------------------------------
// 7) 실행
// ------------------------------------------------------------
async function main() {
  if (!API_KEY) {
    console.error('ANTHROPIC_API_KEY가 설정되지 않았습니다. 저장소 Settings > Secrets에서 확인하세요.');
    process.exit(1);
  }
  const now = new Date();
  const t = kstParts(now);
  const todayKST = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' }).format(now);
  const nowISO = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(now).replace(' ', 'T') + '+09:00';
  const end = new Date(Date.UTC(t.y, t.m - 1, t.d) + 35 * 86400000);
  const ctx = {
    todayKST, year: t.y, month: t.m, day: t.d,
    calendar: buildCalendar(now, 42),
    windowLabel: `${t.m}.${t.d} ~ ${end.getUTCMonth() + 1}.${end.getUTCDate()}`,
    tips: await fetchTipComments(),
  };
  const prev = readPrevious();
  ctx.previousTopics = prev.topics;

  // 1단계
  const { findings, gaps } = await runResearch(ctx);
  console.log(`[1단계 완료] 근거 ${findings.length}건, 조사 공백 ${gaps.length}건`);
  if (findings.length < 15) {
    console.error('근거가 너무 적어 data.json을 갱신하지 않습니다. 조사 공백:', gaps);
    process.exit(1);
  }

  // 2단계
  console.log('[2단계] 카드 작성 중');
  const draftText = await callClaude({ prompt: composePrompt(ctx, findings), maxTokens: 16000 });
  const draft = extractJson(draftText);
  if (!draft || !Array.isArray(draft.weeks) || !draft.weeks.length) {
    console.error('카드 초안을 만들지 못했습니다. 원문 일부:\n', draftText.slice(0, 1500));
    process.exit(1);
  }

  // 3단계
  console.log('[3단계] 독립 검증 중');
  let verified = draft;
  let verificationLog = [];
  const downgrade = (obj) => obj.weeks.forEach(w => (w.cards || []).forEach(c => { c.confidence = '재확인 필요'; }));
  try {
    const vText = await callWithResearchTools({ prompt: verifyPrompt(ctx, draft), maxTokens: 16000 });
    const v = extractJson(vText);
    if (v && Array.isArray(v.weeks) && v.weeks.length) {
      verificationLog = Array.isArray(v.verification_log) ? v.verification_log : [];
      delete v.verification_log;
      verified = v;
    } else {
      verificationLog = ['검증 단계 결과를 읽지 못해 초안을 사용 — 모든 카드를 "재확인 필요"로 낮춤'];
      downgrade(verified);
    }
  } catch (e) {
    verificationLog = ['검증 단계 오류: ' + e.message.slice(0, 120)];
    downgrade(verified);
  }

  // 4단계
  const report = codeValidate(verified, ctx);
  const cardCount = verified.weeks.reduce((n, w) => n + (w.cards || []).length, 0);
  if (cardCount < 5) {
    console.error('검증 후 카드가 5개 미만이라 data.json을 갱신하지 않습니다.');
    process.exit(1);
  }

  verified.generated_at = nowISO;
  verified.quality = {
    findings: findings.length,
    research_gaps: gaps,
    verification_log: verificationLog,
    weekday_fixes: report.weekdayFixes,
    dropped_sources: report.droppedSources,
    notes: report.notes
  };

  if (prev.raw) fs.writeFileSync('data.prev.json', JSON.stringify(prev.raw, null, 2), 'utf-8');
  fs.writeFileSync('data.json', JSON.stringify(verified, null, 2), 'utf-8');
  console.log('data.json 갱신 완료. 주차:', verified.weeks.length, '카드:', cardCount);
  console.log('요일 자동 수정:', report.weekdayFixes.length, '| 제거된 출처:', report.droppedSources.length, '| 조사 공백:', gaps.length);
  if (gaps.length) console.log('조사 공백 상세:', gaps);
}

module.exports = { fixWeekdays, codeValidate, buildCalendar, extractJson, dowOf, seenUrls };

if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1); });
}
