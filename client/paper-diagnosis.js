function paperDiagnosisView() {
  return v2Card('本张试卷 · 逐生诊断',
    '<div data-paper-diagnosis aria-live="polite"><p class="hint" role="status">正在读取本次校对结果…</p></div>');
}

function bindPaperDiagnosis() {
  const root = document.querySelector('[data-paper-diagnosis]');
  if (!root) return;
  const sessionId = state.sessionId;
  const endpoint = '/api/physics-exam/assessments/' + encodeURIComponent(sessionId) + '/diagnosis';
  let data, studentId = wbUI().focusStudent, selected = new Set();
  const current = () => root.isConnected && state.sessionId === sessionId;

  const load = async () => {
    try {
      const session = v2Session();
      if (!Domain.confirmationCurrent(session, 'wrongbook') || !Domain.confirmationCurrent(session, 'scores')) {
        root.innerHTML = '<p class="hint">确认本次成绩与错题校对后，这里会显示每位学生的结果。</p>';
        return;
      }
      await v2Flush();
      data = await Api.request(endpoint);
      if (current()) draw();
    } catch (error) {
      if (!current()) return;
      root.innerHTML = '<p class="warning-note">' + escapeHtml(error.message) + '</p><button class="secondary" data-paper-diagnosis-retry>重试</button>';
      v2Action('[data-paper-diagnosis-retry]', load, root);
    }
  };

  const draw = () => {
    if (!data.available) {
      root.innerHTML = '<p class="hint">' + escapeHtml(data.reason) + '</p>';
      return;
    }
    const attended = data.students.filter(row => row.attendance === 'present').length;
    const absent = data.students.filter(row => row.attendance === 'absent').length;
    const paper = data.exams.find(exam => exam.id === data.examId);
    const unmatched = data.unmapped.map(column => '第' + column + '题').join('、');
    root.innerHTML = '<p class="hint">共 ' + data.students.length + ' 人 · 已核对作答 ' + attended + ' 人 · 缺考 ' + absent +
      ' 人 · 正误未确定 ' + (data.students.length - attended - absent) + ' 人</p>' +
      (data.questionStats?.length ? '<details class="diagnosis-class-stats"><summary>本卷逐题统计</summary>' +
        '<p class="hint">按答错和空题人数降序。核实人数包含答对、答错和明确空题；缺考、无成绩和看不清的作答单独记。</p>' +
        '<div class="table-wrap"><table><thead><tr><th scope="col">题号</th><th scope="col">核实人数</th><th scope="col">答对</th>' +
        '<th scope="col">答错</th><th scope="col">空题</th><th scope="col">未核实</th></tr></thead><tbody>' +
        data.questionStats.map(row => '<tr><th scope="row">第 ' + escapeHtml(row.column) + ' 题</th><td>' + (row.correct + row.incorrect + row.blank) +
          '</td><td>' + row.correct + '</td><td>' + row.incorrect + '</td><td>' + row.blank + '</td><td>' + row.unknown + '</td></tr>').join('') +
        '</tbody></table></div></details>' : '') +
      '<div class="actions"><label class="field"><span>查找学生</span><input data-diagnosis-search type="search" placeholder="输入姓名" /></label>' +
      '<label class="field"><span>学生</span><select data-diagnosis-student></select></label></div>' +
      '<div data-diagnosis-student-result></div>' +
      '<details data-paper-source-options><summary>关联同一份原卷 · 已对应 ' + data.mapped.length + '/' + (data.mapped.length + data.unmapped.length) + ' 题</summary>' +
      '<p class="hint">' + (paper ? '当前原卷：' + escapeHtml(paper.label) + '。' : '已校对的正误可直接查看。关联同一份原卷后，可补充题型、做题方法和同类题。') +
      (unmatched ? ' 尚未对应：' + escapeHtml(unmatched) + '。' : '') + '</p>' +
      (data.exams.length ? '<div class="actions"><label class="field"><span>已审核原卷</span><select data-diagnosis-exam><option value="">请选择原卷</option>' +
        data.exams.map(exam => '<option value="' + escapeAttr(exam.id) + '"' + (exam.id === data.examId ? ' selected' : '') + '>' +
          escapeHtml(exam.label) + ' · 已审 ' + exam.reviewed + ' 题</option>').join('') + '</select></label><div data-diagnosis-original></div></div>' +
        '<label><input type="checkbox" data-diagnosis-paper-confirm /> 已对照确认是同一份原卷</label>' +
        '<div class="actions"><button class="secondary" data-save-diagnosis-binding>确认原卷关联</button>' +
        (paper ? '<button class="ghost" data-remove-diagnosis-binding>取消关联</button>' : '') + '</div>'
        : '<p class="hint">题库暂无已审核原题。可从中考分析引擎查看原卷并逐题核验。</p><button class="secondary" data-diagnosis-open-exam>打开中考分析引擎</button>') +
      '<p data-diagnosis-mapping-status role="status"></p></details>';
    const search = root.querySelector('[data-diagnosis-search]');
    const select = root.querySelector('[data-diagnosis-student]');
    const showOptions = () => {
      const term = search.value.trim().toLocaleLowerCase();
      const rows = data.students.filter(row => row.name.toLocaleLowerCase().includes(term));
      if (!rows.some(row => row.id === studentId)) studentId = rows[0]?.id || '';
      select.replaceChildren(...rows.map(row => new Option(row.name + (row.attendance === 'absent' ? '（缺考）' : ''), row.id, false, row.id === studentId)));
      showStudent();
    };
    search.addEventListener('input', event => {if (!event.isComposing) showOptions();});
    search.addEventListener('compositionend', showOptions);
    select.addEventListener('change', () => { studentId = select.value; wbUI().focusStudent = studentId; showStudent(); });
    const examSelect = root.querySelector('[data-diagnosis-exam]');
    if (examSelect) {
      const confirmed = root.querySelector('[data-diagnosis-paper-confirm]');
      const original = root.querySelector('[data-diagnosis-original]');
      const renderOriginal = () => {
        const source = data.exams.find(exam => exam.id === examSelect.value);
        confirmed.checked = false;
        original.innerHTML = source?.originalUrl ? '<a class="secondary" target="_blank" rel="noopener" href="' +
          escapeAttr(source.originalUrl) + '">查看原卷 ↗</a>' : '';
      };
      examSelect.addEventListener('change', renderOriginal);
      renderOriginal();
      v2Action('[data-save-diagnosis-binding]', () => saveBinding(examSelect.value, confirmed.checked), root);
      v2Action('[data-remove-diagnosis-binding]', () => saveBinding('', false), root);
    }
    v2Action('[data-diagnosis-open-exam]', () => v2Navigate('exam'), root);
    showOptions();
  };

  const showStudent = () => {
    selected = new Set();
    const output = root.querySelector('[data-diagnosis-student-result]');
    const student = data.students.find(row => row.id === studentId);
    if (!student || student.attendance !== 'present') {
      output.innerHTML = '<p class="hint">' + (!student ? '没有匹配的学生。' : student.attendance === 'absent' ?
        '该生缺考，本次无作答统计。' : '该生成绩或作答未核实，本次无作答统计。') + '</p>';
      return;
    }
    const { correct, incorrect, blank, unknown } = student.outcomes;
    const labels = items => items.map(({ column }) => '第' + column + '题').join('、');
    const needsPractice = [...incorrect, ...blank];
    const candidates = new Map();
    for (const { column } of needsPractice) for (const question of data.questions[column].similar) {
      if (!candidates.has(question.id)) candidates.set(question.id, { ...question, from: [] });
      candidates.get(question.id).from.push(column);
    }
    const corrections = v2Session().corrections.filter(task => task.studentId === student.id);
    const correctionQuestions = new Set(corrections.map(task => String(task.question)));
    const unassigned = needsPractice.filter(row => !correctionQuestions.has(String(row.column))).length;
    output.innerHTML = '<div class="section-title-row"><h4>' + escapeHtml(student.name) + '</h4><p class="hint">答对 ' + correct.length +
      ' · 答错 ' + incorrect.length + ' · 空题 ' + blank.length + ' · 未核实 ' + unknown.length + '</p></div>' +
      (needsPractice.length || corrections.length
        ? '<div class="actions">' + (unassigned ? '<button type="button" class="primary" data-diagnosis-assign>布置订正 · ' + unassigned + ' 题</button>' : '') +
          (corrections.length ? '<button type="button" class="secondary" data-diagnosis-open-corrections>查看该生订正 · ' +
          corrections.filter(task => task.status === 'passed').length + '/' + corrections.length + ' 已通过</button>' : '') +
          '<span data-diagnosis-correction-status role="status"></span></div>' : '') +
      (correct.length ? '<details><summary>查看答对题目</summary><p>' + escapeHtml(labels(correct)) + '</p></details>' : '') +
      (unknown.length ? '<p class="hint">未核实：' + escapeHtml(labels(unknown)) + '。不计入正误。</p>' : '') +
      needsPractice.map(({ column, answer }) => {
        const q = data.questions[column];
        const isBlank = blank.some(row => row.column === column);
        return '<section class="diagnosis-item"><h4>第 ' + escapeHtml(column) + ' 题 · ' + (isBlank ? '空题' : '答错') + '</h4><p>' +
          (isBlank ? '' : '学生原答 ' + escapeHtml(answer) + '。') + (q.correctAnswer ? '标准答案 ' + escapeHtml(q.correctAnswer) + '。' : '') + '</p>' +
          ([q.type, q.point, q.model].filter(Boolean).length ? '<p class="hint">' + escapeHtml([...new Set([q.type, q.point, q.model].filter(Boolean))].join(' · ')) + '</p>' : '') +
          (q.method ? '<p><strong>做题方法</strong> ' + escapeHtml(q.method) + '</p>' : '') + '</section>';
      }).join('') +
      (candidates.size ? '<details open><summary>同类练习</summary><p class="hint">按物理模型或考点找不同试卷的原题。候选题在核验后才能导出。</p>' +
        [...candidates.values()].map(question => '<label class="diagnosis-practice"><input type="checkbox" data-diagnosis-practice="' +
          escapeAttr(question.id) + '"><span><strong>' + escapeHtml(question.match + ' · ' + question.source + ' 第' + question.number + '题') + '</strong>' +
          '<small>' + escapeHtml('对应错题 ' + question.from.join('、') + (question.ready ? ' · 已核验' : ' · 待核验')) + '</small>' +
          '<span>' + escapeHtml(question.stem) + '</span></span></label>').join('') +
        '<button class="primary" data-create-diagnosis-practice disabled>生成同类题练习单</button> <span data-diagnosis-practice-result role="status"></span></details>'
        : needsPractice.length ? '<p class="hint">' + (data.mapped.length ? '本地暂无对应模型或考点的可用原题。' : '要查找同类练习，请先关联同一份已审核原卷。') + '</p>' : '');
    const submit = output.querySelector('[data-create-diagnosis-practice]');
    v2Action('[data-diagnosis-assign]', async () => {
      const status = output.querySelector('[data-diagnosis-correction-status]');
      const submittedStudent = student.id;
      try {
        const result = await v2Mutation(endpoint + '/corrections', { studentId: submittedStudent, confirmationVersion: data.confirmationVersion });
        data.panelRevision = result.revision;
        if (!current() || submittedStudent !== studentId) return;
        showStudent();
        const updated = output.querySelector('[data-diagnosis-correction-status]');
        if (updated) updated.textContent = result.created ? '已布置并保存 ' + result.created + ' 题。' : '订正任务已存在。';
        output.querySelector('[data-diagnosis-open-corrections]')?.focus();
      } catch (error) {
        if (status?.isConnected) status.textContent = error.message;
      }
    }, output);
    v2Action('[data-diagnosis-open-corrections]', () => {
      wbUI().correctionFilter = { sessionId, studentId: student.id };
      wbUI().wrongbookTab = 'corrections';
      render();
    }, output);
    output.querySelectorAll('[data-diagnosis-practice]').forEach(box => box.addEventListener('change', () => {
      if (box.checked) selected.add(box.dataset.diagnosisPractice);
      else selected.delete(box.dataset.diagnosisPractice);
      submit.disabled = selected.size === 0;
    }));
    v2Action('[data-create-diagnosis-practice]', async () => {
      const status = output.querySelector('[data-diagnosis-practice-result]');
      const submittedStudent = studentId;
      try {
        const result = await Api.request(endpoint + '/practice', { ...versions(), studentId, questionIds: [...selected] });
        data.revision = result.revision;
        if (!current() || submittedStudent !== studentId || !status.isConnected) return;
        status.innerHTML = '已保存 · <a href="/exam-engine/index.html?set=' + encodeURIComponent(result.id) +
          '" target="_blank" rel="noopener">打开练习单确认并下载 ↗</a>';
      } catch (error) { if (status.isConnected) status.textContent = error.message; }
    }, output);
  };

  const versions = () => ({ baseRevision: data.revision, panelRevision: data.panelRevision });
  const saveBinding = async (examId, confirmSamePaper) => {
    const status = root.querySelector('[data-diagnosis-mapping-status]');
    if (examId && !confirmSamePaper) { status.textContent = '请先查看并确认两份试卷相同。'; return; }
    try {
      data = await Api.request(endpoint + '/binding', { ...versions(), examId, confirmSamePaper });
      if (!current()) return;
      draw();
      root.querySelector('[data-paper-source-options]').open = true;
      root.querySelector('[data-diagnosis-mapping-status]').textContent = examId ? '原卷关联已保存。' : '已取消关联。';
    } catch (error) { if (status.isConnected) status.textContent = error.message; }
  };
  load();
}
