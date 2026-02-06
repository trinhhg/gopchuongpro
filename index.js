// CONFIG V30
const DB_NAME = 'WriterCore_V30';
const DB_VERSION = 1;
let db = null;
let files = [];
let folders = [];
let historyLogs = [];
let checklists = {}; 
let currentFolderId = 'root';
let currentView = 'manager';
let previewFileId = null;
let currentHistoryFilter = 'all'; // State cho filter history

// --- 1. GLOBAL HELPERS (Đưa lên đầu để tránh lỗi ReferenceError) ---
function countWords(text) { 
    if (!text || !text.trim()) return 0; 
    return text.trim().split(/\s+/).length; 
}

function getChapterNum(title) { 
    const match = title.match(/(?:Chương|Chapter|Hồi)\s*(\d+(\.\d+)?)/i); 
    return match ? parseFloat(match[1]) : 999999; 
}

function cleanContent(text) { 
    return text.split('\n').map(l => l.trim()).filter(l => l.length > 0); 
}

function generateDocxFromSegments(mainHeader, segments) { 
    const { Document, Packer, Paragraph, TextRun } = docx; 
    const children = []; 
    children.push(new Paragraph({children: [new TextRun({text: mainHeader, font: "Calibri", size: 32, color: "000000"})], spacing: {after: 240}})); 
    children.push(new Paragraph({text: "", spacing: {after: 240}})); 
    segments.forEach(seg => { 
        seg.lines.forEach(line => { 
            children.push(new Paragraph({children: [new TextRun({text: line, font: "Calibri", size: 32, color: "000000"})], spacing: {after: 240}})); 
        }); 
    }); 
    return Packer.toBlob(new Document({sections:[{children}]})); 
}

// --- DOM ELEMENTS ---
const els = {
    folderSelect: document.getElementById('folderSelect'),
    btnNewFolder: document.getElementById('btnNewFolder'),
    btnEditFolder: document.getElementById('btnEditFolder'),
    btnDeleteFolder: document.getElementById('btnDeleteFolder'),
    searchInput: document.getElementById('searchInput'),
    // Tabs
    btnViewFiles: document.getElementById('btnViewFiles'),
    btnViewHistory: document.getElementById('btnViewHistory'),
    btnViewChecklist: document.getElementById('btnViewChecklist'),
    // Views
    viewManager: document.getElementById('viewManager'),
    viewHistory: document.getElementById('viewHistory'),
    viewChecklist: document.getElementById('viewChecklist'),
    // Grid
    fileGrid: document.getElementById('fileGrid'),
    fileCount: document.getElementById('fileCount'),
    selectAll: document.getElementById('selectAll'),
    // Actions
    btnDownloadBatch: document.getElementById('btnDownloadBatch'),
    btnDownloadDirect: document.getElementById('btnDownloadDirect'),
    btnDeleteBatch: document.getElementById('btnDeleteBatch'),
    // History
    historyTableBody: document.getElementById('historyTableBody'),
    btnClearHistory: document.getElementById('btnClearHistory'),
    // Checklist
    checklistBody: document.getElementById('checklistBody'),
    btnClearChecklist: document.getElementById('btnClearChecklist'),
    progCount: document.getElementById('progCount'),
    progBar: document.getElementById('progBar'),
    btnImportChecklist: document.getElementById('btnImportChecklist'),
    checklistInput: document.getElementById('checklistInput'),
    // Inputs (Hidden)
    chapterTitle: document.getElementById('chapterTitle'),
    autoGroup: document.getElementById('autoGroup'),
    btnMerge: document.getElementById('btnMerge'),
    editor: document.getElementById('editor'),
    // Preview
    previewModal: document.getElementById('previewModal'),
    previewTitle: document.getElementById('previewTitle'),
    previewDocHeader: document.getElementById('previewDocHeader'),
    previewBody: document.getElementById('previewBody'),
    toast: document.getElementById('toast')
};

// --- INIT SYSTEM ---
async function init() {
    try {
        await initDB(); 
        await loadData();
        console.log("✅ System V30 Ready");

        // UI Events
        els.btnNewFolder.onclick = createFolder;
        els.btnEditFolder.onclick = editFolderName;
        els.btnDeleteFolder.onclick = deleteCurrentFolder;
        els.folderSelect.onchange = (e) => { currentFolderId = e.target.value; reloadAllViews(); };

        els.btnViewFiles.onclick = () => switchView('manager');
        els.btnViewHistory.onclick = () => switchView('history');
        els.btnViewChecklist.onclick = () => switchView('checklist');
        els.searchInput.oninput = () => { if(currentView==='manager') renderFiles(); else renderHistory(); };

        els.btnImportChecklist.onclick = importChecklist;
        els.btnClearChecklist.onclick = clearChecklist;
        els.btnClearHistory.onclick = clearHistory;

        // History Filter Tabs
        document.querySelectorAll('.filter-chip').forEach(btn => {
            btn.onclick = () => {
                document.querySelectorAll('.filter-chip').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                currentHistoryFilter = btn.dataset.filter;
                renderHistory();
            };
        });

        els.selectAll.onchange = (e) => { getFilteredFiles().forEach(f => f.selected = e.target.checked); renderFiles(); };
        els.btnDownloadBatch.onclick = downloadBatchZip;
        els.btnDownloadDirect.onclick = downloadBatchDirect;
        els.btnDeleteBatch.onclick = deleteBatch;

        // MERGE TRIGGER (FIXED)
        els.btnMerge.onclick = async () => {
            const title = els.chapterTitle.value;
            const content = els.editor.value;
            const autoGroup = els.autoGroup.checked;
            els.editor.value = ''; 
            await performMerge(title, content, autoGroup);
        };

        // Auto Refresh
        document.addEventListener("visibilitychange", async () => {
            if (document.visibilityState === "visible") {
                await loadData();
                reloadAllViews();
            }
        });

    } catch (e) {
        alert("Lỗi khởi tạo: " + e.message);
    }
}

function reloadAllViews() {
    renderFiles();
    renderChecklist();
    renderHistory();
}

// --- MERGE LOGIC ---
async function performMerge(inputTitle, content, autoGroup) {
    if (!content.trim()) return;

    let safeName = inputTitle.replace(/[:*?"<>|]/g, " -").trim();
    let fileName = `${safeName}.docx`;
    const lines = cleanContent(content);
    const chapterNum = getChapterNum(inputTitle);
    
    // Logic gộp thông minh
    const match = inputTitle.match(/(?:Chương|Chapter|Hồi)\s*(\d+(\.\d+)?)/i);
    if (autoGroup && match) {
        fileName = `Chương ${Math.floor(parseFloat(match[1]))}.docx`;
    }

    let segment = { idSort: chapterNum, lines: lines, header: inputTitle };
    let targetFile = files.find(f => f.name === fileName && f.folderId === currentFolderId);

    if (targetFile) {
        if (!targetFile.segments) targetFile.segments = [];
        
        const exists = targetFile.segments.find(s => s.header === inputTitle);
        if (exists) {
            exists.lines = lines; 
            addToLog(`Đã cập nhật: ${inputTitle}`, 'warn'); // Warn = Quét trùng/Update
        } else {
            targetFile.segments.push(segment);
            addToLog(`Đã gộp: ${inputTitle} vào ${fileName}`, 'success'); // Success = Quét nội dung
        }

        targetFile.segments.sort((a,b) => a.idSort - b.idSort);
        let allText = targetFile.segments.map(s => s.lines.join('\n')).join('\n\n');
        
        targetFile.headerInDoc = targetFile.name.replace('.docx','');
        targetFile.wordCount = countWords(allText);
        targetFile.timestamp = Date.now();
        targetFile.blob = await generateDocxFromSegments(targetFile.headerInDoc, targetFile.segments);
        
        await saveDB('files', targetFile);
        // Cập nhật RAM ngay để lần sau F2 nhận ra file này
        const idx = files.findIndex(f => f.id === targetFile.id);
        if (idx !== -1) files[idx] = targetFile;

    } else {
        const wc = countWords(lines.join(' '));
        targetFile = {
            id: Date.now(), name: fileName, folderId: currentFolderId,
            segments: [segment],
            headerInDoc: inputTitle,
            wordCount: wc, timestamp: Date.now(), selected: false
        };
        targetFile.blob = await generateDocxFromSegments(inputTitle, targetFile.segments);
        
        await saveDB('files', targetFile);
        files.push(targetFile);
        addToLog(`Tạo mới: ${fileName}`, 'success');
    }

    // Refresh UI
    if(document.visibilityState === "visible") {
        renderFiles();
        renderChecklist(); // Update ngay tiến độ
        renderHistory();
    }
}

// --- CHECKLIST LOGIC ---
function importChecklist() {
    try {
        const raw = els.checklistInput.value;
        if(!raw) return;
        const newItems = JSON.parse(raw);
        let currentList = checklists[currentFolderId] || [];
        let count = 0;

        newItems.forEach(item => {
            if(!currentList.find(x => x.num === item.num)) {
                currentList.push(item);
                count++;
            }
        });

        currentList.sort((a,b) => a.num - b.num);
        checklists[currentFolderId] = currentList;
        saveDB('checklists', {folderId: currentFolderId, list: currentList});

        if(count > 0) addToLog(`Đã thêm ${count} chương vào danh sách.`, 'success');
        
        switchView('checklist');
        renderChecklist();
        toast(`Đã cập nhật danh sách!`);
    } catch(e) { console.error(e); }
}

function renderChecklist() {
    const list = checklists[currentFolderId] || [];
    const currentFiles = files.filter(f => f.folderId === currentFolderId);
    
    // Tạo Map các chương đã có
    const doneMap = new Set();
    currentFiles.forEach(f => {
        if(f.segments) f.segments.forEach(s => doneMap.add(s.idSort));
        else doneMap.add(getChapterNum(f.name));
    });

    els.checklistBody.innerHTML = '';
    let doneCount = 0;

    if(list.length === 0) {
        els.checklistBody.innerHTML = '<tr><td colspan="3" style="text-align:center;padding:20px;color:#94a3b8">Danh sách trống</td></tr>';
        els.progCount.innerText = "0/0"; els.progBar.style.width = "0%";
        return;
    }

    const frag = document.createDocumentFragment();
    list.forEach(item => {
        const isDone = doneMap.has(item.num);
        if(isDone) doneCount++;
        
        const tr = document.createElement('tr');
        tr.className = `checklist-item ${isDone ? 'done' : ''}`;
        tr.innerHTML = `
            <td><span class="badge ${isDone?'success':'warn'}">${isDone?'Đã gộp':'Chờ...'}</span></td>
            <td>${item.title}</td>
            <td style="text-align:right">#${item.num}</td>
        `;
        frag.appendChild(tr);
    });
    els.checklistBody.appendChild(frag);

    els.progCount.innerText = `${doneCount}/${list.length}`;
    els.progBar.style.width = `${(doneCount/list.length)*100}%`;
}

// --- HISTORY LOGIC (Tabs & Columns) ---
function addToLog(msg, type='info') {
    const log = {
        id: Date.now() + Math.random(),
        folderId: currentFolderId,
        time: new Date().toLocaleTimeString('vi-VN'),
        msg: msg,
        type: type,
        timestamp: Date.now()
    };
    
    // Giữ 100 log/folder
    const folderLogs = historyLogs.filter(l => l.folderId === currentFolderId);
    if(folderLogs.length >= 100) {
        const oldest = folderLogs[folderLogs.length-1];
        historyLogs = historyLogs.filter(l => l.id !== oldest.id);
        const tx = db.transaction('history', 'readwrite');
        tx.objectStore('history').delete(oldest.id);
    }
    
    historyLogs.unshift(log);
    saveDB('history', log);
    if(currentView==='history') renderHistory();
}

function renderHistory() {
    const logs = historyLogs.filter(l => l.folderId === currentFolderId);
    const filter = currentHistoryFilter;

    const display = logs.filter(l => {
        if(filter === 'all') return true;
        if(filter === 'success') return l.type === 'success' || l.type === 'info';
        if(filter === 'error') return l.type === 'error' || l.type === 'warn';
        return true;
    });

    els.historyTableBody.innerHTML = '';
    
    if (display.length === 0) {
         els.historyTableBody.innerHTML = '<tr><td colspan="3" style="text-align:center; padding: 20px; color:#94a3b8">Không có dữ liệu.</td></tr>';
         return;
    }

    const frag = document.createDocumentFragment();
    display.forEach(l => {
        const tr = document.createElement('tr');
        // Map type sang Label
        let label = 'NỘI DUNG'; // Success
        let css = 'success';
        if (l.type === 'warn' || l.type === 'error') { label = 'TRÙNG/LỖI'; css = 'error'; }
        
        tr.innerHTML = `
            <td>${l.time}</td>
            <td><span class="badge ${css}">${label}</span></td>
            <td>${l.msg}</td>
        `;
        frag.appendChild(tr);
    });
    els.historyTableBody.appendChild(frag);
}

// --- DB & GENERAL ---
function initDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e) => {
            db = e.target.result;
            if(!db.objectStoreNames.contains('files')) db.createObjectStore('files', {keyPath: 'id'});
            if(!db.objectStoreNames.contains('folders')) db.createObjectStore('folders', {keyPath: 'id'});
            if(!db.objectStoreNames.contains('history')) db.createObjectStore('history', {keyPath: 'id'});
            if(!db.objectStoreNames.contains('checklists')) db.createObjectStore('checklists', {keyPath: 'folderId'});
        };
        req.onsuccess = (e) => { db = e.target.result; resolve(); };
        req.onerror = reject;
    });
}

function loadData() {
    return Promise.all([
        getAll('files'), getAll('folders'), getAll('history'), getAll('checklists')
    ]).then(([f, fo, h, c]) => {
        files = f || [];
        folders = fo || [];
        historyLogs = (h || []).sort((a,b) => b.timestamp - a.timestamp);
        c.forEach(i => checklists[i.folderId] = i.list);
        if(!folders.find(x => x.id === 'root')) {
            const root = {id:'root', name:'Thư mục chính'};
            folders.push(root);
            saveDB('folders', root);
        }
        renderFolders();
    });
}

// Helpers
function getAll(s) { return new Promise(r => db.transaction(s,'readonly').objectStore(s).getAll().onsuccess=e=>r(e.target.result||[])); }
function saveDB(s, i) { return new Promise(r => { const tx=db.transaction(s,'readwrite'); tx.objectStore(s).put(i); tx.oncomplete=r; }); }
function delDB(s, id) { const tx=db.transaction(s,'readwrite'); tx.objectStore(s).delete(id); }

function createFolder() { const n = prompt("Tên thư mục:"); if(n) { const f = {id: Date.now().toString(), name: n}; folders.push(f); saveDB('folders', f); currentFolderId = f.id; renderFolders(); reloadAllViews(); } }
function editFolderName() { if(currentFolderId === 'root') return alert("Gốc!"); const f = folders.find(x=>x.id===currentFolderId); const n = prompt("Tên mới:", f.name); if(n){ f.name=n; saveDB('folders',f); renderFolders(); } }
function deleteCurrentFolder() { if(currentFolderId === 'root') return; if(confirm("Xóa?")) { files.filter(f=>f.folderId===currentFolderId).forEach(f=>delDB('files',f.id)); files=files.filter(f=>f.folderId!==currentFolderId); delDB('folders', currentFolderId); folders=folders.filter(f=>f.id!==currentFolderId); currentFolderId='root'; renderFolders(); reloadAllViews(); } }
function renderFolders() { els.folderSelect.innerHTML = ''; folders.forEach(f => { const opt = document.createElement('option'); opt.value = f.id; opt.innerText = f.name; if(f.id === currentFolderId) opt.selected = true; els.folderSelect.appendChild(opt); }); }

function getFilteredFiles() { let list = files.filter(f => f.folderId === currentFolderId); if(els.searchInput.value && currentView === 'manager') list = list.filter(f => f.name.toLowerCase().includes(els.searchInput.value.toLowerCase())); list.sort((a,b) => getChapterNum(a.name) - getChapterNum(b.name)); return list; }
function renderFiles() { const list = getFilteredFiles(); els.fileCount.innerText = list.length; els.fileGrid.innerHTML = ''; list.forEach(f => { const div = document.createElement('div'); div.className = `file-card ${f.selected?'selected':''}`; div.innerHTML = ` <div class="card-icon">📄</div> <div class="file-name" title="${f.name}">${f.name}</div> <div class="file-meta">${f.wordCount} chữ</div> `; div.onclick = () => { f.selected = !f.selected; renderFiles(); }; els.fileGrid.appendChild(div); }); }

function toast(m) { els.toast.innerText = m; els.toast.className = 'toast show'; setTimeout(()=>els.toast.className='toast', 2000); }
function switchView(v) { 
    currentView = v; 
    document.querySelectorAll('.view-panel').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    if(v==='manager') { els.viewManager.classList.add('active'); els.btnViewFiles.classList.add('active'); renderFiles(); }
    if(v==='checklist') { els.viewChecklist.classList.add('active'); els.btnViewChecklist.classList.add('active'); renderChecklist(); }
    if(v==='history') { els.viewHistory.classList.add('active'); els.btnViewHistory.classList.add('active'); renderHistory(); }
}
function deleteBatch() { const s = getFilteredFiles().filter(f=>f.selected); if(s.length && confirm(`Xóa ${s.length} file?`)) { s.forEach(f=>{ delDB('files',f.id); }); files=files.filter(f=>!f.selected || f.folderId!==currentFolderId); renderFiles(); } }
function downloadBatchZip() { const s = getFilteredFiles().filter(f=>f.selected); if(!s.length) return toast('Chưa chọn file'); const z = new JSZip(); s.forEach(f=>z.file(f.name, f.blob)); z.generateAsync({type:"blob"}).then(c=>saveAs(c, `Batch.zip`)); }
async function downloadBatchDirect() { const s = getFilteredFiles().filter(f=>f.selected); if(!s.length) return toast('Chưa chọn file'); for(let i=0;i<s.length;i++){ if(s[i].blob){ saveAs(s[i].blob, s[i].name); await new Promise(r=>setTimeout(r,200)); }} }
function clearChecklist() { if(confirm("Xóa danh sách?")){ delete checklists[currentFolderId]; delDB('checklists', currentFolderId); renderChecklist(); } }
function clearHistory() { if(confirm("Xóa lịch sử?")){ const toDel = historyLogs.filter(l=>l.folderId===currentFolderId); toDel.forEach(l=>delDB('history',l.id)); historyLogs=historyLogs.filter(l=>l.folderId!==currentFolderId); renderHistory(); } }

window.openPreview = (id) => {}; // (Giữ nguyên logic preview nếu cần)
window.closePreview = () => els.previewModal.classList.remove('show');

init();
