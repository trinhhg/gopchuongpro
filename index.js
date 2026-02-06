// CONFIG
const DB_NAME = 'AutoPilotV27'; // Nâng version DB để chắc chắn sạch lỗi cũ
const DB_VERSION = 3;
let db = null;
let files = [];
let folders = [];
let historyLogs = [];
let checklists = {}; 
let currentFolderId = 'root'; // Mặc định
let currentView = 'manager';
let previewFileId = null;

// QUEUE SYSTEM
let mergeQueue = []; 
let isProcessingQueue = false;

// --- WORKER FOR ANTI-THROTTLING ---
let keepAliveWorker = null;
function initWorker() {
    const workerScript = `
        self.onmessage = function(e) {
            if (e.data === 'start') setInterval(() => { postMessage('tick'); }, 200);
        };
    `;
    const blob = new Blob([workerScript], { type: 'application/javascript' });
    keepAliveWorker = new Worker(URL.createObjectURL(blob));
    keepAliveWorker.onmessage = function(e) {
        if (e.data === 'tick' && mergeQueue.length > 0 && !isProcessingQueue) processQueue();
    };
    keepAliveWorker.postMessage('start');
}

// --- HELPERS ---
function countWords(text) { if (!text || !text.trim()) return 0; return text.trim().split(/\s+/).length; }
function getChapterNum(title) { const match = title.match(/(?:Chương|Chapter|Hồi)\s*(\d+(\.\d+)?)/i); return match ? parseFloat(match[1]) : Date.now(); }
function cleanContent(text) { return text.split('\n').map(l => l.trim()).filter(l => l.length > 0); }

// --- DOM ---
const els = {
    folderSelect: document.getElementById('folderSelect'),
    btnNewFolder: document.getElementById('btnNewFolder'),
    btnDeleteFolder: document.getElementById('btnDeleteFolder'),
    searchInput: document.getElementById('searchInput'),
    btnViewFiles: document.getElementById('btnViewFiles'),
    btnViewHistory: document.getElementById('btnViewHistory'),
    btnViewChecklist: document.getElementById('btnViewChecklist'),
    viewManager: document.getElementById('viewManager'),
    viewHistory: document.getElementById('viewHistory'),
    viewChecklist: document.getElementById('viewChecklist'),
    fileGrid: document.getElementById('fileGrid'),
    fileCount: document.getElementById('fileCount'),
    selectAll: document.getElementById('selectAll'),
    btnDownloadBatch: document.getElementById('btnDownloadBatch'),
    btnDownloadDirect: document.getElementById('btnDownloadDirect'),
    btnDeleteBatch: document.getElementById('btnDeleteBatch'),
    historyFilter: document.getElementById('historyFilter'),
    historyTableBody: document.getElementById('historyTableBody'),
    emptyHistory: document.getElementById('emptyHistory'),
    btnClearHistory: document.getElementById('btnClearHistory'),
    checklistBody: document.getElementById('checklistBody'),
    btnClearChecklist: document.getElementById('btnClearChecklist'),
    progCount: document.getElementById('progCount'),
    progBar: document.getElementById('progBar'),
    btnImportChecklist: document.getElementById('btnImportChecklist'),
    checklistInput: document.getElementById('checklistInput'),
    chapterTitle: document.getElementById('chapterTitle'),
    autoGroup: document.getElementById('autoGroup'),
    btnMerge: document.getElementById('btnMerge'),
    editor: document.getElementById('editor'),
    previewModal: document.getElementById('previewModal'),
    previewTitle: document.getElementById('previewTitle'),
    previewDocHeader: document.getElementById('previewDocHeader'),
    previewBody: document.getElementById('previewBody'),
    toast: document.getElementById('toast')
};

// --- INIT ---
async function init() {
    await initDB();
    initWorker();

    localStorage.setItem('is_merging_busy', 'false');

    // FIX F5: Lấy folder cũ từ localStorage
    const savedFolder = localStorage.getItem('last_folder_id');
    // Kiểm tra xem folder đã lưu có còn tồn tại trong DB không
    if (savedFolder && folders.find(f => f.id === savedFolder)) {
        currentFolderId = savedFolder;
    } else {
        currentFolderId = 'root';
    }
    
    // Render lại UI với folder đúng
    renderFolders();
    renderFiles();
    renderChecklist(); // Render checklist theo folder hiện tại

    els.btnNewFolder.onclick = createFolder;
    els.btnDeleteFolder.onclick = deleteCurrentFolder;
    
    // SỰ KIỆN ĐỔI FOLDER: Lưu lại ngay vào localStorage
    els.folderSelect.onchange = (e) => { 
        currentFolderId = e.target.value; 
        localStorage.setItem('last_folder_id', currentFolderId); // <--- LƯU LẠI
        renderFiles(); 
        renderChecklist();
        switchView(currentView); 
    };
    
    els.btnViewFiles.onclick = () => switchView('manager');
    els.btnViewHistory.onclick = () => switchView('history');
    els.btnViewChecklist.onclick = () => switchView('checklist');
    
    els.searchInput.oninput = () => { currentView === 'manager' ? renderFiles() : renderHistory(); };
    els.btnImportChecklist.onclick = importChecklist;
    els.btnClearChecklist.onclick = clearChecklist;
    
    els.historyFilter.onchange = renderHistory;
    els.selectAll.onchange = (e) => { getFilteredFiles().forEach(f => f.selected = e.target.checked); renderFiles(); };
    els.btnDownloadBatch.onclick = downloadBatchZip;
    els.btnDownloadDirect.onclick = downloadBatchDirect;
    els.btnDeleteBatch.onclick = deleteBatch;
    els.btnClearHistory.onclick = () => { if(confirm("Xóa lịch sử?")){ historyLogs=[]; clearStore('history'); renderHistory(); } };

    els.btnMerge.onclick = () => {
        const payload = {
            title: els.chapterTitle.value,
            content: els.editor.value,
            autoGroup: els.autoGroup.checked
        };
        els.editor.value = ''; 
        mergeQueue.push(payload);
        processQueue();
    };
    
    document.addEventListener('keydown', e => {
        if(els.previewModal.classList.contains('show')) {
            if(e.key === 'ArrowLeft') prevChapter();
            if(e.key === 'ArrowRight') nextChapter();
            if(e.key === 'Escape') closePreview();
        }
    });
}

// --- QUEUE PROCESSOR ---
async function processQueue() {
    if (isProcessingQueue) return; 
    if (mergeQueue.length === 0) {
        localStorage.setItem('is_merging_busy', 'false');
        return;
    }

    isProcessingQueue = true;
    localStorage.setItem('is_merging_busy', 'true');

    try {
        const task = mergeQueue.shift();
        await performMerge(task);
    } catch (e) {
        console.error("Lỗi xử lý:", e);
    } finally {
        isProcessingQueue = false;
        if(mergeQueue.length > 0) setTimeout(processQueue, 10);
    }
}

// --- CORE MERGE LOGIC ---
async function performMerge(task) {
    const { title: inputTitle, content, autoGroup } = task;
    if (!content.trim()) return;

    let safeName = inputTitle.replace(/[:*?"<>|]/g, " -").trim();
    let fileName = `${safeName}.docx`;
    const lines = cleanContent(content);
    const chapterNum = getChapterNum(inputTitle);
    let segment = { idSort: chapterNum, lines: lines, header: inputTitle };

    if (autoGroup) {
        const match = inputTitle.match(/(?:Chương|Chapter|Hồi)\s*(\d+)/i);
        if (match) fileName = `Chương ${match[1]}.docx`;
    }

    let targetFile = files.find(f => f.name === fileName && f.folderId === currentFolderId);

    if (targetFile) {
        if (!targetFile.segments) targetFile.segments = [];
        const existingIndex = targetFile.segments.findIndex(s => s.idSort === chapterNum);
        
        if (existingIndex !== -1) {
            targetFile.segments[existingIndex] = segment;
            addToLog(`Cập nhật: ${inputTitle}`, 'warn');
        } else {
            targetFile.segments.push(segment);
            addToLog(`Gộp: ${inputTitle}`, 'success');
        }

        targetFile.segments.sort((a,b) => a.idSort - b.idSort);
        let allText = "";
        targetFile.segments.forEach(seg => { allText += seg.lines.join('\n') + '\n'; });
        targetFile.headerInDoc = targetFile.name.replace('.docx','');
        targetFile.wordCount = countWords(targetFile.headerInDoc + " " + allText);
        targetFile.timestamp = Date.now();
        targetFile.blob = await generateDocxFromSegments(targetFile.headerInDoc, targetFile.segments);
        saveDB('files', targetFile);
        
    } else {
        const wc = countWords(inputTitle + " " + content);
        targetFile = {
            id: Date.now(), name: fileName, folderId: currentFolderId,
            segments: [segment],
            headerInDoc: inputTitle,
            wordCount: wc, timestamp: Date.now(), selected: false
        };
        targetFile.blob = await generateDocxFromSegments(inputTitle, targetFile.segments);
        files.push(targetFile);
        saveDB('files', targetFile);
        addToLog(`Mới: ${fileName}`, 'info');
        addToLog(`Gộp: ${inputTitle}`, 'success');
    }

    if (currentView === 'manager') renderFiles();
    if (currentView === 'checklist') renderChecklist();
}

// --- CHECKLIST & DUPLICATE CHECK ---
function importChecklist() {
    try {
        const raw = els.checklistInput.value;
        if(!raw) return;
        const newItems = JSON.parse(raw);

        historyLogs = [];
        clearStore('history');

        const countMap = {};
        const duplicates = [];
        newItems.forEach(item => {
            countMap[item.num] = (countMap[item.num] || 0) + 1;
            if (countMap[item.num] === 2) duplicates.push(item.num);
        });

        if (duplicates.length > 0) {
            duplicates.sort((a,b) => a - b);
            const msg = `⚠️ TRÙNG CHƯƠNG: ${duplicates.join(', ')}`;
            addToLog(msg, 'error');
            toast('Có chương trùng! Xem tab Thông báo.', 'danger');
            switchView('history');
        } else {
            addToLog(`✅ Danh sách sạch: ${newItems.length} chương.`, 'success');
            toast(`Đã nhập ${newItems.length} chương.`, 'success');
            switchView('checklist');
        }

        let currentList = newItems; 
        currentList.sort((a,b) => a.num - b.num);
        checklists[currentFolderId] = currentList;
        saveDB('checklists', {folderId: currentFolderId, list: currentList});
        
        renderChecklist(); 
        renderHistory();

    } catch(e) { console.error(e); }
}

function clearChecklist() {
    if(confirm("Xóa danh sách?")) {
        delete checklists[currentFolderId];
        delDB('checklists', currentFolderId);
        renderChecklist();
    }
}

function renderChecklist() {
    const list = checklists[currentFolderId] || [];
    const currentFiles = files.filter(f => f.folderId === currentFolderId);
    const doneChapters = new Set();
    currentFiles.forEach(f => {
        if(f.segments && f.segments.length > 0) f.segments.forEach(s => doneChapters.add(s.idSort));
        else doneChapters.add(getChapterNum(f.name));
    });

    els.checklistBody.innerHTML = '';
    let doneCount = 0;
    if(list.length === 0) {
        els.checklistBody.innerHTML = '<div class="empty-state">Chưa có dữ liệu. F2 bên web truyện để quét.</div>';
    } else {
        const frag = document.createDocumentFragment();
        list.forEach(item => {
            const isDone = doneChapters.has(item.num);
            if(isDone) doneCount++;
            const div = document.createElement('div');
            div.className = `cl-item ${isDone ? 'done' : ''}`;
            div.innerHTML = `<div class="col-status">${isDone ? '✅ Xong' : '⏱️ Chưa'}</div><div class="col-title">${item.title}</div><div class="col-num">#${item.num}</div>`;
            frag.appendChild(div);
        });
        els.checklistBody.appendChild(frag);
    }
    els.progCount.innerText = `${doneCount}/${list.length}`;
    const percent = list.length > 0 ? (doneCount / list.length) * 100 : 0;
    els.progBar.style.width = `${percent}%`;
}

// --- DB ---
function initDB() {
    return new Promise(resolve => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = e => {
            const d = e.target.result;
            if(!d.objectStoreNames.contains('files')) d.createObjectStore('files', {keyPath: 'id'});
            if(!d.objectStoreNames.contains('folders')) d.createObjectStore('folders', {keyPath: 'id'});
            if(!d.objectStoreNames.contains('history')) d.createObjectStore('history', {keyPath: 'id'});
            if(!d.objectStoreNames.contains('checklists')) d.createObjectStore('checklists', {keyPath: 'folderId'});
        };
        req.onsuccess = e => { db = e.target.result; loadData().then(resolve); };
    });
}
async function loadData() {
    files = await getAll('files');
    folders = await getAll('folders');
    historyLogs = (await getAll('history')).sort((a,b)=>b.timestamp-a.timestamp);
    const clData = await getAll('checklists');
    clData.forEach(item => checklists[item.folderId] = item.list);
    if(!folders.find(f=>f.id==='root')) {
        folders.push({id:'root', name:'Thư mục chính'});
        saveDB('folders', {id:'root', name:'Thư mục chính'});
    }
    // Dữ liệu đã load xong, init() sẽ xử lý việc chọn folder
}
function addToLog(msg, type = 'success') {
    const now = new Date();
    const time = now.toLocaleTimeString('vi-VN', {hour:'2-digit', minute:'2-digit', second:'2-digit'});
    const logItem = { id: Date.now(), time: time, msg: msg, type: type, timestamp: now.getTime() };
    historyLogs.unshift(logItem); 
    saveDB('history', logItem);
    if(historyLogs.length > 500) { const removed = historyLogs.pop(); delDB('history', removed.id); }
    if(currentView === 'history') renderHistory();
}
function renderHistory() {
    const keyword = els.searchInput.value.toLowerCase();
    const filterType = els.historyFilter.value; 
    const filtered = historyLogs.filter(log => {
        const matchSearch = log.msg.toLowerCase().includes(keyword);
        let logGroup = 'success';
        if (log.type === 'warn' || log.type === 'error') logGroup = 'error';
        const matchType = filterType === 'all' || 
                          (filterType === 'error' && (log.type === 'warn' || log.type === 'error')) ||
                          (filterType === 'success' && (log.type === 'success' || log.type === 'info'));
        return matchSearch && matchType;
    });
    els.historyTableBody.innerHTML = '';
    filtered.forEach(log => {
        const tr = document.createElement('tr');
        let badgeClass = log.type;
        let typeLabel = log.type.toUpperCase();
        if(log.type === 'error') { typeLabel = 'TRÙNG/LỖI'; badgeClass = 'error'; }
        if(log.type === 'warn') { typeLabel = 'CẬP NHẬT'; badgeClass = 'warn'; }
        if(log.type === 'success') { typeLabel = 'OK'; badgeClass = 'success'; }
        tr.innerHTML = `<td>${log.time}</td><td><span class="badge-status ${badgeClass}">${typeLabel}</span></td><td class="${log.type==='error'?'text-danger':''}">${log.msg}</td>`;
        els.historyTableBody.appendChild(tr);
    });
}
function getAll(s) { return new Promise(r => db.transaction(s,'readonly').objectStore(s).getAll().onsuccess=e=>r(e.target.result||[])); }
function saveDB(s, i) { db.transaction(s,'readwrite').objectStore(s).put(i); }
function delDB(s, id) { db.transaction(s,'readwrite').objectStore(s).delete(id); }
function clearStore(s) { const tx = db.transaction(s, 'readwrite'); tx.objectStore(s).clear(); }
function renderFolders() {
    els.folderSelect.innerHTML = '';
    folders.forEach(f => {
        const opt = document.createElement('option');
        opt.value = f.id; opt.innerText = f.name;
        if(f.id === currentFolderId) opt.selected = true;
        els.folderSelect.appendChild(opt);
    });
}
function createFolder() { 
    const n = prompt("Tên:"); 
    if(n) { 
        const f = {id: Date.now().toString(), name: n}; 
        folders.push(f); 
        saveDB('folders', f); 
        currentFolderId = f.id; 
        localStorage.setItem('last_folder_id', currentFolderId); // Lưu luôn
        renderFolders(); renderFiles(); renderChecklist();
    } 
}
function deleteCurrentFolder() { if(currentFolderId === 'root') return toast("Lỗi: Root", 'danger'); if(confirm("Xóa?")) { files.filter(f=>f.folderId===currentFolderId).forEach(f=>delDB('files',f.id)); files = files.filter(f=>f.folderId!==currentFolderId); delDB('folders', currentFolderId); folders = folders.filter(f=>f.id!==currentFolderId); currentFolderId = 'root'; localStorage.setItem('last_folder_id', 'root'); renderFolders(); renderFiles(); switchView(currentView); } }
function getFilteredFiles() { let list = files.filter(f => f.folderId === currentFolderId); if(currentView === 'manager') { const keyword = els.searchInput.value.toLowerCase().trim(); if(keyword) list = list.filter(f => f.name.toLowerCase().includes(keyword)); } list.sort((a,b) => getChapterNum(a.name) - getChapterNum(b.name)); return list; }
function renderFiles() { const list = getFilteredFiles(); els.fileCount.innerText = list.length; els.fileGrid.innerHTML = ''; list.forEach(f => { const card = document.createElement('div'); card.className = `file-card ${f.selected ? 'selected' : ''}`; card.onclick = (e) => { if(e.target.closest('.card-actions')||e.target.closest('.card-body')) return; f.selected = !f.selected; renderFiles(); }; card.innerHTML = ` <div class="card-header"><input type="checkbox" class="card-chk" ${f.selected?'checked':''}><div class="card-icon">📄</div></div> <div class="card-body" title="Xem"><div class="file-name">${f.name}</div><div class="file-info"><span class="tag-wc">${f.wordCount} words</span></div></div> <div class="card-actions"><button class="btn-small view" onclick="event.stopPropagation(); openPreview(${f.id})">👁 Xem</button><button class="btn-small del" onclick="event.stopPropagation(); deleteOne(${f.id})">🗑 Xóa</button></div> `; const chk = card.querySelector('.card-chk'); chk.onclick=e=>e.stopPropagation(); chk.onchange=()=>{f.selected=chk.checked;renderFiles();}; card.querySelector('.card-body').onclick=e=>{e.stopPropagation();openPreview(f.id);}; els.fileGrid.appendChild(card); }); }
function generateDocxFromSegments(mainHeader, segments) { const { Document, Packer, Paragraph, TextRun } = docx; const children = []; children.push(new Paragraph({children: [new TextRun({text: mainHeader, font: "Calibri", size: 32, color: "000000"})], spacing: {after: 240}})); children.push(new Paragraph({text: "", spacing: {after: 240}})); segments.forEach(seg => { seg.lines.forEach(line => { children.push(new Paragraph({children: [new TextRun({text: line, font: "Calibri", size: 32, color: "000000"})], spacing: {after: 240}})); }); }); return Packer.toBlob(new Document({sections:[{children}]})); }

window.openPreview = (id) => { const f = files.find(x=>x.id===id); if(!f) return; previewFileId = id; const list = getFilteredFiles(); const idx = list.findIndex(x=>x.id===id); els.previewTitle.innerText = f.name; document.querySelector('.modal-nav span').innerText = `${idx+1}/${list.length}`; els.previewDocHeader.innerText = f.headerInDoc; let content = ""; if(f.segments) f.segments.forEach(seg => seg.lines.forEach(l => content += `<p>${l}</p>`)); else content = f.rawContent.split('\n').map(l=>`<p>${l}</p>`).join(''); els.previewBody.innerHTML = content; els.previewModal.classList.add('show'); };
window.closePreview = () => els.previewModal.classList.remove('show');
window.prevChapter = () => navChapter(-1);
window.nextChapter = () => navChapter(1);
function navChapter(d) { const l = getFilteredFiles(); const i = l.findIndex(x=>x.id===previewFileId); if(i!==-1 && l[i+d]) openPreview(l[i+d].id); else toast(d>0?"Hết":"Đầu"); }
window.downloadOne = (id) => { const f=files.find(x=>x.id===id); if(f&&f.blob) saveAs(f.blob, f.name); };
window.deleteOne = (id) => { if(confirm('Xóa?')) { delDB('files', id); files=files.filter(f=>f.id!==id); renderFiles(); } };
function deleteBatch() { const s = getFilteredFiles().filter(f=>f.selected); if(confirm(`Xóa ${s.length}?`)) { s.forEach(f=>delDB('files',f.id)); files=files.filter(f=>!f.selected || f.folderId!==currentFolderId); renderFiles(); } }
function downloadBatchZip() { const s = getFilteredFiles().filter(f=>f.selected); if(!s.length) return toast("Chưa chọn", 'error'); const z = new JSZip(); s.forEach(f=>z.file(f.name, f.blob)); z.generateAsync({type:"blob"}).then(c=>saveAs(c, `Batch_${Date.now()}.zip`)); }
async function downloadBatchDirect() { const s = getFilteredFiles().filter(f=>f.selected); if(!s.length) return toast("Chưa chọn", 'error'); toast(`Tải ${s.length} file...`); for(let i=0;i<s.length;i++) { if(s[i].blob) { saveAs(s[i].blob, s[i].name); await new Promise(r=>setTimeout(r,200)); } } }
function toast(m, type='info') { els.toast.innerText = m; els.toast.className = `toast show ${type}`; setTimeout(()=>els.toast.classList.remove('show'), 2000); }
function switchView(view) { currentView = view; [els.btnViewFiles, els.btnViewHistory, els.btnViewChecklist].forEach(b => b.classList.remove('active')); [els.viewManager, els.viewHistory, els.viewChecklist].forEach(v => v.classList.remove('active')); if(view === 'manager') { els.btnViewFiles.classList.add('active'); els.viewManager.classList.add('active'); renderFiles(); } else if(view === 'history') { els.btnViewHistory.classList.add('active'); els.viewHistory.classList.add('active'); renderHistory(); } else if(view === 'checklist') { els.btnViewChecklist.classList.add('active'); els.viewChecklist.classList.add('active'); renderChecklist(); } }

init();
