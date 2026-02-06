// CONFIG V29 - STABLE
const DB_NAME = 'WriterCore_V29';
const DB_VERSION = 1; // New DB for clean start
let db = null;
let files = [];
let folders = [];
let historyLogs = [];
let checklists = {}; 
let currentFolderId = 'root';
let currentView = 'manager';
let previewFileId = null;

// DOM
const els = {
    folderSelect: document.getElementById('folderSelect'),
    btnNewFolder: document.getElementById('btnNewFolder'),
    btnEditFolder: document.getElementById('btnEditFolder'), // New
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
    historyFilter: document.getElementById('historyFilter'),
    historyTableBody: document.getElementById('historyTableBody'),
    btnClearHistory: document.getElementById('btnClearHistory'),
    // Checklist
    checklistBody: document.getElementById('checklistBody'),
    btnClearChecklist: document.getElementById('btnClearChecklist'),
    progCount: document.getElementById('progCount'),
    progBar: document.getElementById('progBar'),
    btnImportChecklist: document.getElementById('btnImportChecklist'),
    checklistInput: document.getElementById('checklistInput'),
    // Inputs
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
        await initDB(); // Chờ kết nối DB xong hẳn
        await loadData(); // Load dữ liệu lên RAM
        
        console.log("✅ System Ready");

        // Event Listeners
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
        els.historyFilter.onchange = renderHistory;
        els.btnClearHistory.onclick = clearHistory;

        els.selectAll.onchange = (e) => { 
            getFilteredFiles().forEach(f => f.selected = e.target.checked); 
            renderFiles(); 
        };
        els.btnDownloadBatch.onclick = downloadBatchZip;
        els.btnDownloadDirect.onclick = downloadBatchDirect;
        els.btnDeleteBatch.onclick = deleteBatch;

        // MERGE TRIGGER
        els.btnMerge.onclick = async () => {
            const title = els.chapterTitle.value;
            const content = els.editor.value;
            const autoGroup = els.autoGroup.checked;
            els.editor.value = ''; // Reset ngay
            await performMerge(title, content, autoGroup);
        };

        // Auto Refresh khi switch tab (Fix F5)
        document.addEventListener("visibilitychange", async () => {
            if (document.visibilityState === "visible") {
                await loadData();
                reloadAllViews();
            }
        });

        // Keyboard
        document.addEventListener('keydown', e => {
            if(els.previewModal.classList.contains('show')) {
                if(e.key === 'ArrowLeft') prevChapter();
                if(e.key === 'ArrowRight') nextChapter();
                if(e.key === 'Escape') closePreview();
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

// --- CORE LOGIC (V23 Based + Robust Fixes) ---
async function performMerge(inputTitle, content, autoGroup) {
    if (!content.trim()) return;

    let safeName = inputTitle.replace(/[:*?"<>|]/g, " -").trim();
    let fileName = `${safeName}.docx`;
    const lines = content.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    
    // Parse Chapter Number
    const match = inputTitle.match(/(?:Chương|Chapter|Hồi)\s*(\d+(\.\d+)?)/i);
    const chapterNum = match ? parseFloat(match[1]) : 999999;

    let segment = { idSort: chapterNum, lines: lines, header: inputTitle };

    // Smart Merge Logic
    if (autoGroup && match) {
        // Chương 1.1 -> Chương 1.docx
        fileName = `Chương ${Math.floor(parseFloat(match[1]))}.docx`;
    }

    // Tìm file trong RAM (Vì RAM đã được sync từ DB)
    let targetFile = files.find(f => f.name === fileName && f.folderId === currentFolderId);

    if (targetFile) {
        // APPEND MODE
        if (!targetFile.segments) targetFile.segments = [];
        
        // Check trùng lặp đoạn trong file
        const exists = targetFile.segments.find(s => s.header === inputTitle);
        if (exists) {
            exists.lines = lines; // Update content
            addToLog(`Cập nhật nội dung: ${inputTitle}`, 'warn');
        } else {
            targetFile.segments.push(segment);
            addToLog(`Gộp: ${inputTitle} vào file ${fileName}`, 'success');
        }

        // Sort & Rebuild
        targetFile.segments.sort((a,b) => a.idSort - b.idSort);
        let allText = targetFile.segments.map(s => s.lines.join('\n')).join('\n\n');
        
        targetFile.headerInDoc = targetFile.name.replace('.docx','');
        targetFile.wordCount = countWords(allText);
        targetFile.timestamp = Date.now();
        targetFile.blob = await generateDocxFromSegments(targetFile.headerInDoc, targetFile.segments);
        
        // SAVE TO DB & UPDATE RAM
        await saveDB('files', targetFile);
        
        // Quan trọng: Update lại mảng files global để lần F2 tiếp theo tìm thấy nó
        const idx = files.findIndex(f => f.id === targetFile.id);
        if (idx !== -1) files[idx] = targetFile;

    } else {
        // NEW FILE MODE
        const wc = countWords(lines.join(' '));
        targetFile = {
            id: Date.now(), 
            name: fileName, 
            folderId: currentFolderId,
            segments: [segment],
            headerInDoc: inputTitle,
            wordCount: wc, 
            timestamp: Date.now(), 
            selected: false
        };
        targetFile.blob = await generateDocxFromSegments(inputTitle, targetFile.segments);
        
        await saveDB('files', targetFile);
        files.push(targetFile); // Push vào RAM ngay
        
        addToLog(`Tạo mới file: ${fileName}`, 'success');
    }

    // Refresh UI
    if(document.visibilityState === "visible") {
        renderFiles();
        renderChecklist();
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
        toast(`Đã nhập danh sách!`);
    } catch(e) { console.error(e); }
}

function renderChecklist() {
    const list = checklists[currentFolderId] || [];
    const currentFiles = files.filter(f => f.folderId === currentFolderId);
    
    const doneMap = new Set();
    currentFiles.forEach(f => {
        if(f.segments) f.segments.forEach(s => doneMap.add(s.idSort));
        else doneMap.add(getChapterNum(f.name));
    });

    els.checklistBody.innerHTML = '';
    let doneCount = 0;

    if(list.length === 0) {
        els.checklistBody.innerHTML = '<div style="padding:20px; text-align:center; color:#9ca3af">Danh sách trống</div>';
        return;
    }

    const frag = document.createDocumentFragment();
    list.forEach(item => {
        const isDone = doneMap.has(item.num);
        if(isDone) doneCount++;
        
        const div = document.createElement('div');
        div.className = `checklist-item ${isDone ? 'done' : ''}`;
        div.innerHTML = `
            <div class="col-status">
                <span class="status-badge ${isDone?'done':'pending'}">${isDone?'Đã gộp':'Chờ gộp'}</span>
            </div>
            <div class="col-name">${item.title}</div>
            <div class="col-idx">#${item.num}</div>
        `;
        frag.appendChild(div);
    });
    els.checklistBody.appendChild(frag);

    els.progCount.innerText = `${doneCount}/${list.length}`;
    els.progBar.style.width = `${(doneCount/list.length)*100}%`;
}

// --- DB CONNECTION (FIXED DATA LOSS) ---
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

        req.onsuccess = (e) => {
            db = e.target.result;
            resolve();
        };
        
        req.onerror = (e) => reject(e);
    });
}

// Load data with Promise
function loadData() {
    return Promise.all([
        getAll('files'),
        getAll('folders'),
        getAll('history'),
        getAll('checklists')
    ]).then(([f, fo, h, c]) => {
        files = f || [];
        folders = fo || [];
        historyLogs = (h || []).sort((a,b) => b.timestamp - a.timestamp);
        c.forEach(i => checklists[i.folderId] = i.list);
        
        // Ensure Root Folder
        if(!folders.find(x => x.id === 'root')) {
            const root = {id:'root', name:'Thư mục chính'};
            folders.push(root);
            saveDB('folders', root);
        }
        renderFolders();
    });
}

function getAll(store) {
    return new Promise(resolve => {
        const tx = db.transaction(store, 'readonly');
        tx.objectStore(store).getAll().onsuccess = e => resolve(e.target.result);
    });
}

function saveDB(store, item) {
    return new Promise(resolve => {
        const tx = db.transaction(store, 'readwrite');
        tx.objectStore(store).put(item);
        tx.oncomplete = () => resolve();
    });
}

// --- HELPERS & UI ---
function addToLog(msg, type='info') {
    const log = {
        id: Date.now() + Math.random(),
        folderId: currentFolderId,
        time: new Date().toLocaleTimeString('vi-VN'),
        msg: msg,
        type: type,
        timestamp: Date.now()
    };
    
    // Filter logic: Keep only 100 per folder
    const folderLogs = historyLogs.filter(l => l.folderId === currentFolderId);
    if(folderLogs.length >= 100) {
        // Remove oldest
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
    const filter = els.historyFilter.value;
    const logs = historyLogs.filter(l => l.folderId === currentFolderId);
    
    const display = logs.filter(l => {
        if(filter === 'all') return true;
        if(filter === 'success') return l.type === 'success';
        return l.type !== 'success';
    });

    els.historyTableBody.innerHTML = '';
    display.forEach(l => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${l.time}</td>
            <td><span class="badge ${l.type}">${l.type.toUpperCase()}</span></td>
            <td>${l.msg}</td>
        `;
        els.historyTableBody.appendChild(tr);
    });
}

function createFolder() {
    const n = prompt("Nhập tên thư mục:");
    if(n) {
        const f = {id: Date.now().toString(), name: n};
        folders.push(f);
        saveDB('folders', f);
        currentFolderId = f.id;
        renderFolders();
        reloadAllViews();
    }
}

function editFolderName() {
    if(currentFolderId === 'root') return alert("Không thể đổi tên thư mục gốc");
    const f = folders.find(x => x.id === currentFolderId);
    const n = prompt("Đổi tên thành:", f.name);
    if(n) {
        f.name = n;
        saveDB('folders', f);
        renderFolders();
    }
}

function deleteCurrentFolder() {
    if(currentFolderId === 'root') return alert("Không thể xóa thư mục gốc");
    if(confirm("Xóa thư mục này và toàn bộ dữ liệu bên trong?")) {
        // Delete files
        files.filter(f => f.folderId === currentFolderId).forEach(f => {
            const tx = db.transaction('files', 'readwrite');
            tx.objectStore('files').delete(f.id);
        });
        files = files.filter(f => f.folderId !== currentFolderId);
        
        // Delete folder
        const tx = db.transaction('folders', 'readwrite');
        tx.objectStore('folders').delete(currentFolderId);
        folders = folders.filter(f => f.id !== currentFolderId);
        
        currentFolderId = 'root';
        renderFolders();
        reloadAllViews();
    }
}

function renderFolders() {
    els.folderSelect.innerHTML = '';
    folders.forEach(f => {
        const opt = document.createElement('option');
        opt.value = f.id; 
        opt.innerText = f.name;
        if(f.id === currentFolderId) opt.selected = true;
        els.folderSelect.appendChild(opt);
    });
}

function getFilteredFiles() {
    let list = files.filter(f => f.folderId === currentFolderId);
    if(els.searchInput.value && currentView === 'manager') {
        const k = els.searchInput.value.toLowerCase();
        list = list.filter(f => f.name.toLowerCase().includes(k));
    }
    // Sort logic: Chương 1, Chương 2...
    list.sort((a,b) => getChapterNum(a.name) - getChapterNum(b.name));
    return list;
}

function renderFiles() {
    const list = getFilteredFiles();
    els.fileCount.innerText = list.length;
    els.fileGrid.innerHTML = '';
    
    list.forEach(f => {
        const div = document.createElement('div');
        div.className = `file-card ${f.selected?'selected':''}`;
        div.innerHTML = `
            <div class="card-header">
                <div class="card-icon">📄</div>
            </div>
            <div class="file-name" title="${f.name}">${f.name}</div>
            <div class="file-meta">${f.wordCount} words</div>
            <div class="card-actions">
                <button class="btn-small view">Xem</button>
                <button class="btn-small del" style="color:#ef4444">Xóa</button>
            </div>
        `;
        // Events
        div.onclick = () => { f.selected = !f.selected; renderFiles(); };
        div.querySelector('.view').onclick = (e) => { e.stopPropagation(); openPreview(f.id); };
        div.querySelector('.del').onclick = (e) => { 
            e.stopPropagation(); 
            if(confirm('Xóa file?')) {
                const tx = db.transaction('files', 'readwrite');
                tx.objectStore('files').delete(f.id);
                files = files.filter(x => x.id !== f.id);
                renderFiles();
            }
        };
        els.fileGrid.appendChild(div);
    });
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

// Utils
function toast(m) { els.toast.innerText = m; els.toast.className = 'toast show'; setTimeout(()=>els.toast.className='toast', 2000); }
function switchView(v) { 
    currentView = v; 
    document.querySelectorAll('.view-panel').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    
    if(v==='manager') { els.viewManager.classList.add('active'); els.btnViewFiles.classList.add('active'); renderFiles(); }
    if(v==='checklist') { els.viewChecklist.classList.add('active'); els.btnViewChecklist.classList.add('active'); renderChecklist(); }
    if(v==='history') { els.viewHistory.classList.add('active'); els.btnViewHistory.classList.add('active'); renderHistory(); }
}

// Preview Funcs
window.openPreview = (id) => { const f = files.find(x=>x.id===id); if(!f)return; previewFileId=id; els.previewTitle.innerText = f.name; els.previewDocHeader.innerText = f.headerInDoc; let c=""; if(f.segments) f.segments.forEach(s=>s.lines.forEach(l=>c+=`<p>${l}</p>`)); els.previewBody.innerHTML=c; els.previewModal.classList.add('show'); };
window.closePreview = () => els.previewModal.classList.remove('show');
window.prevChapter = () => { const l=getFilteredFiles(); const i=l.findIndex(x=>x.id===previewFileId); if(i>0) openPreview(l[i-1].id); };
window.nextChapter = () => { const l=getFilteredFiles(); const i=l.findIndex(x=>x.id===previewFileId); if(i<l.length-1) openPreview(l[i+1].id); };

function downloadBatchZip() { const s = getFilteredFiles().filter(f=>f.selected); if(!s.length) return toast('Chưa chọn file'); const z = new JSZip(); s.forEach(f=>z.file(f.name, f.blob)); z.generateAsync({type:"blob"}).then(c=>saveAs(c, `Batch_${Date.now()}.zip`)); }
async function downloadBatchDirect() { const s = getFilteredFiles().filter(f=>f.selected); if(!s.length) return toast('Chưa chọn file'); toast(`Tải ${s.length} file...`); for(let i=0;i<s.length;i++){ if(s[i].blob){ saveAs(s[i].blob, s[i].name); await new Promise(r=>setTimeout(r,200)); }} }
function deleteBatch() { const s = getFilteredFiles().filter(f=>f.selected); if(s.length && confirm(`Xóa ${s.length} file?`)) { s.forEach(f=>{ const tx=db.transaction('files','readwrite'); tx.objectStore('files').delete(f.id); }); files=files.filter(f=>!f.selected || f.folderId!==currentFolderId); renderFiles(); } }
function clearChecklist() { if(confirm("Xóa danh sách?")){ delete checklists[currentFolderId]; const tx=db.transaction('checklists','readwrite'); tx.objectStore('checklists').delete(currentFolderId); renderChecklist(); } }
function clearHistory() { if(confirm("Xóa lịch sử thư mục này?")){ const toDel = historyLogs.filter(l=>l.folderId===currentFolderId); toDel.forEach(l=>{ const tx=db.transaction('history','readwrite'); tx.objectStore('history').delete(l.id); }); historyLogs=historyLogs.filter(l=>l.folderId!==currentFolderId); renderHistory(); } }

init();
