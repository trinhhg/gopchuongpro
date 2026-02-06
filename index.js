// CONFIG
const DB_NAME = 'AutoPilotV26_2_Fix';
const DB_VERSION = 3;
const CHANNEL_NAME = 'writer_core_v26';

let db = null;
let files = [];
let folders = [];
let logs = [];
let checklists = {}; 
let currentFolderId = 'root';
let currentView = 'manager';
let previewFileId = null;
let currentFilter = 'all';

// BROADCAST CHANNEL
const commChannel = new BroadcastChannel(CHANNEL_NAME);

// DOM ELEMENTS
const els = {
    folderSelect: document.getElementById('folderSelect'),
    btnNewFolder: document.getElementById('btnNewFolder'),
    btnDeleteFolder: document.getElementById('btnDeleteFolder'),
    btnRenameFolder: document.getElementById('btnRenameFolder'),
    searchInput: document.getElementById('searchInput'),
    
    // View Tabs
    btnViewFiles: document.getElementById('btnViewFiles'),
    btnViewChecklist: document.getElementById('btnViewChecklist'),
    btnViewHistory: document.getElementById('btnViewHistory'),
    views: {
        manager: document.getElementById('viewManager'),
        checklist: document.getElementById('viewChecklist'),
        history: document.getElementById('viewHistory')
    },

    // Manager
    fileGrid: document.getElementById('fileGrid'),
    fileCount: document.getElementById('fileCount'),
    selectAll: document.getElementById('selectAll'),
    btnDownloadBatch: document.getElementById('btnDownloadBatch'),
    btnDownloadDirect: document.getElementById('btnDownloadDirect'),
    btnDeleteBatch: document.getElementById('btnDeleteBatch'),

    // Checklist
    checklistBody: document.getElementById('checklistBody'),
    btnClearChecklist: document.getElementById('btnClearChecklist'),
    progCount: document.getElementById('progCount'),
    progBar: document.getElementById('progBar'),
    
    // History
    historyTableBody: document.getElementById('historyTableBody'),
    historyFilters: document.querySelectorAll('.filter-btn'),
    btnClearHistory: document.getElementById('btnClearHistory'),

    // Hidden & Modal
    autoGroup: document.getElementById('autoGroup'),
    previewModal: document.getElementById('previewModal'),
    previewTitle: document.getElementById('previewTitle'),
    previewDocHeader: document.getElementById('previewDocHeader'),
    previewBody: document.getElementById('previewBody'),
    toast: document.getElementById('toast')
};

// --- CORE FUNCTIONS (Định nghĩa trước để tránh lỗi ReferenceError) ---

// 1. FOLDER ACTIONS
function createFolder() { 
    const n = prompt("Tên folder mới:"); 
    if(n) { 
        const f = {id: Date.now().toString(), name: n}; 
        folders.push(f); 
        saveDB('folders', f); 
        currentFolderId = f.id; 
        renderFolders(); 
        renderFiles(); 
    } 
}

function renameFolder() {
    const current = folders.find(f => f.id === currentFolderId);
    if (!current) return;
    const newName = prompt("Đổi tên folder:", current.name);
    if (newName && newName.trim() !== "") {
        current.name = newName.trim();
        saveDB('folders', current);
        renderFolders();
        toast("Đã đổi tên folder");
    }
}

function deleteCurrentFolder() { 
    if(confirm("Bạn có chắc muốn xóa folder này và toàn bộ file trong đó?")) { 
        files.filter(f => f.folderId === currentFolderId).forEach(f => delDB('files', f.id));
        files = files.filter(f => f.folderId !== currentFolderId);
        delDB('folders', currentFolderId);
        folders = folders.filter(f => f.id !== currentFolderId);
        
        if (folders.length === 0) {
            const root = {id:'root', name:'Thư mục chính'};
            folders.push(root);
            saveDB('folders', root);
            currentFolderId = 'root';
        } else {
            currentFolderId = folders[0].id;
        }
        renderFolders(); renderFiles(); switchView(currentView);
        toast("Đã xóa folder");
    } 
}

// 2. CHECKLIST ACTIONS
function clearChecklist() {
    if(confirm("Xóa toàn bộ danh sách check?")) {
        delete checklists[currentFolderId];
        delDB('checklists', currentFolderId);
        renderChecklist();
        toast("Đã xóa danh sách");
    }
}

function importChecklist(items) {
    if(!items || items.length === 0) return;
    const seen = new Set();
    const duplicates = [];
    
    items.forEach(item => {
        if(seen.has(item.num)) duplicates.push(item.num);
        else seen.add(item.num);
    });

    if(duplicates.length > 0) {
        const uniqueDupes = [...new Set(duplicates)].sort((a,b)=>a-b);
        addLog('scan_dupe', `Phát hiện chương trùng: ${uniqueDupes.join(', ')}`);
        toast(`⚠️ Cảnh báo: Có ${uniqueDupes.length} chương trùng!`);
        switchView('history'); 
        currentFilter = 'scan';
        updateFilterUI();
    } else {
        addLog('scan_ok', `Quét ${items.length} chương: Danh sách sạch.`);
        toast(`📋 Đã nhập ${items.length} chương.`);
    }

    let currentList = checklists[currentFolderId] || [];
    items.forEach(item => {
        if(!currentList.find(x => x.num === item.num)) currentList.push(item);
    });
    currentList.sort((a,b) => a.num - b.num);
    checklists[currentFolderId] = currentList;
    saveDB('checklists', {folderId: currentFolderId, list: currentList});
    
    renderChecklist();
    renderHistory();
}

// 3. HISTORY ACTIONS
function clearHistory() {
    if(confirm("Xóa toàn bộ nhật ký?")){ 
        logs=[]; 
        clearStore('history'); 
        renderHistory(); 
        toast("Đã dọn dẹp nhật ký");
    }
}

// 4. MERGE LOGIC
async function performMerge(task) {
    const { title, content } = task;
    if (!content || !content.trim()) return;

    let safeName = title.replace(/[:*?"<>|]/g, " -").trim();
    let fileName = `${safeName}.docx`;
    const chapterNum = getChapterNum(title);
    const lines = cleanContent(content);
    let segment = { idSort: chapterNum, lines: lines, header: title };

    if (els.autoGroup.checked) {
        const match = title.match(/(?:Chương|Chapter|Hồi)\s*(\d+)/i);
        if (match) fileName = `Chương ${match[1]}.docx`;
    }

    let targetFile = files.find(f => f.name === fileName && f.folderId === currentFolderId);
    let logMsg = '';

    if (targetFile) {
        if (!targetFile.segments) targetFile.segments = [];
        const existIdx = targetFile.segments.findIndex(s => s.idSort === chapterNum);
        
        if (existIdx !== -1) {
            targetFile.segments[existIdx] = segment;
            logMsg = `Cập nhật: ${title}`;
        } else {
            targetFile.segments.push(segment);
            logMsg = `Gộp thêm: ${title} vào ${fileName}`;
        }
        targetFile.segments.sort((a,b) => a.idSort - b.idSort);
        
        let allText = "";
        targetFile.segments.forEach(seg => { allText += seg.lines.join('\n') + '\n'; });
        targetFile.wordCount = countWords(allText);
        targetFile.blob = await generateDocxFromSegments(fileName.replace('.docx',''), targetFile.segments);
        targetFile.timestamp = Date.now();
        saveDB('files', targetFile);
    } else {
        const wc = countWords(content);
        targetFile = {
            id: Date.now(), name: fileName, folderId: currentFolderId,
            segments: [segment], wordCount: wc, timestamp: Date.now(), selected: false
        };
        targetFile.blob = await generateDocxFromSegments(title, targetFile.segments);
        files.push(targetFile);
        saveDB('files', targetFile);
        logMsg = `Tạo mới: ${fileName}`;
    }

    addLog('merge', logMsg);
    if(currentView === 'manager') renderFiles();
    if(currentView === 'checklist') renderChecklist();
    toast(`✅ Đã xong: ${title}`);
}

// 5. RENDERERS
function renderChecklist() {
    const list = checklists[currentFolderId] || [];
    const currentFiles = files.filter(f => f.folderId === currentFolderId);
    const doneChapters = new Set();
    currentFiles.forEach(f => {
        if(f.segments) f.segments.forEach(s => doneChapters.add(s.idSort));
    });

    els.checklistBody.innerHTML = '';
    let doneCount = 0;

    if(list.length === 0) {
        els.checklistBody.innerHTML = '<div style="padding:40px;text-align:center;color:#9ca3af;font-style:italic">Chưa có dữ liệu. Hãy ấn F2 bên web truyện để quét.</div>';
    } else {
        const frag = document.createDocumentFragment();
        list.forEach(item => {
            const isDone = doneChapters.has(item.num);
            if(isDone) doneCount++;
            
            const div = document.createElement('div');
            // Thêm class 'done' nếu đã xong để CSS xử lý gạch ngang
            div.className = `checklist-item ${isDone ? 'done' : ''}`;
            
            // HTML cho Badge trạng thái (Spinner hoặc Check xanh)
            let statusHtml = '';
            if (isDone) {
                statusHtml = `<span class="status-badge done">✔ Đã gộp</span>`;
            } else {
                statusHtml = `
                    <span class="status-badge pending">
                        <span class="spinner"></span> Đang chờ
                    </span>`;
            }

            div.innerHTML = `
                <div class="col-status">${statusHtml}</div>
                <div class="col-name">${item.title}</div>
                <div class="col-idx">#${item.num}</div>
            `;
            frag.appendChild(div);
        });
        els.checklistBody.appendChild(frag);
    }
    
    els.progCount.innerText = `${doneCount}/${list.length}`;
    const percent = list.length > 0 ? (doneCount / list.length) * 100 : 0;
    els.progBar.style.width = `${percent}%`;
}

function renderHistory() {
    let filtered = logs;
    if (currentFilter === 'scan') filtered = logs.filter(l => l.type.startsWith('scan'));
    else if (currentFilter === 'merge') filtered = logs.filter(l => l.type === 'merge');
    
    const keyword = els.searchInput.value.toLowerCase();
    if(keyword) filtered = filtered.filter(l => l.msg.toLowerCase().includes(keyword));

    els.historyTableBody.innerHTML = '';
    if (filtered.length === 0) {
        els.historyTableBody.innerHTML = '<div style="padding:20px;text-align:center;color:#999">Không có dữ liệu.</div>';
        return;
    }

    const frag = document.createDocumentFragment();
    filtered.forEach(log => {
        const tr = document.createElement('div');
        tr.className = 'table-row';
        let badgeClass = 'info';
        let badgeText = 'Gộp';
        if(log.type === 'scan_dupe') { badgeClass = 'error'; badgeText = 'Trùng'; }
        else if(log.type === 'scan_ok') { badgeClass = 'success'; badgeText = 'Sạch'; }
        
        tr.innerHTML = `
            <div class="col-time">${log.time}</div>
            <div class="col-type"><span class="badge ${badgeClass}">${badgeText}</span></div>
            <div class="col-msg">${log.msg}</div>
        `;
        frag.appendChild(tr);
    });
    els.historyTableBody.appendChild(frag);
}

function renderFolders() { 
    els.folderSelect.innerHTML = ''; 
    folders.forEach(f => { 
        const o = document.createElement('option'); 
        o.value = f.id; 
        o.innerText = f.name; 
        if(f.id===currentFolderId) o.selected=true; 
        els.folderSelect.appendChild(o); 
    }); 
}

function renderFiles() { 
    const l=getFilteredFiles(); 
    els.fileCount.innerText=l.length; 
    els.fileGrid.innerHTML=''; 
    l.forEach(f=>{ 
        const d=document.createElement('div'); 
        d.className=`file-card ${f.selected?'selected':''}`; 
        d.onclick=e=>{ if(e.target.closest('.action-pill')) return; f.selected=!f.selected; renderFiles(); }; 
        d.innerHTML=`
            <div class="card-icon">📄</div>
            <div class="file-name">${f.name}</div>
            <div class="file-meta">${f.wordCount} từ</div>
            <div style="margin-top:auto;display:flex;gap:5px">
                <button class="action-pill" onclick="openPreview(${f.id})">Xem</button>
                <button class="action-pill danger" onclick="deleteOne(${f.id})">Xóa</button>
            </div>`; 
        els.fileGrid.appendChild(d); 
    }); 
}

// --- UTILS ---
function addLog(type, msg) {
    const now = new Date();
    const time = now.toLocaleTimeString('vi-VN', {hour:'2-digit', minute:'2-digit', second:'2-digit'});
    const item = { id: Date.now(), time, type, msg, timestamp: now.getTime() };
    logs.unshift(item);
    if(logs.length > 300) logs.pop();
    saveDB('history', item);
    renderHistory();
}
function updateFilterUI() {
    els.historyFilters.forEach(b => {
        b.classList.toggle('active', b.dataset.filter === currentFilter);
    });
}
function getFilteredFiles() { 
    let l = files.filter(f=>f.folderId===currentFolderId); 
    if(currentView==='manager'){ 
        const k=els.searchInput.value.toLowerCase(); 
        if(k) l=l.filter(f=>f.name.toLowerCase().includes(k)); 
    } 
    return l.sort((a,b)=>getChapterNum(a.name)-getChapterNum(b.name)); 
}
function toast(m) { els.toast.innerText = m; els.toast.classList.add('show'); setTimeout(()=>els.toast.classList.remove('show'), 2000); }
function countWords(s) { return s.trim().split(/\s+/).length; }
function getChapterNum(t) { const m = t.match(/(?:Chương|Chapter|Hồi)\s*(\d+(\.\d+)?)/i); return m ? parseFloat(m[1]) : 0; }
function cleanContent(t) { return t.split('\n').map(l => l.trim()).filter(l => l.length > 0); }

// --- DB & SETUP ---
function initDB() { return new Promise(r => { const req = indexedDB.open(DB_NAME, DB_VERSION); req.onupgradeneeded = e => { const d = e.target.result; if(!d.objectStoreNames.contains('files')) d.createObjectStore('files', {keyPath: 'id'}); if(!d.objectStoreNames.contains('folders')) d.createObjectStore('folders', {keyPath: 'id'}); if(!d.objectStoreNames.contains('history')) d.createObjectStore('history', {keyPath: 'id'}); if(!d.objectStoreNames.contains('checklists')) d.createObjectStore('checklists', {keyPath: 'folderId'}); }; req.onsuccess = e => { db = e.target.result; loadData().then(r); }; }); }

async function loadData() { 
    files = await getAll('files'); 
    folders = await getAll('folders'); 
    logs = (await getAll('history')).sort((a,b)=>b.timestamp-a.timestamp); 
    const c = await getAll('checklists'); 
    c.forEach(i => checklists[i.folderId] = i.list); 
    
    if(folders.length === 0) { 
        folders.push({id:'root', name:'Thư mục chính'}); 
        saveDB('folders', {id:'root', name:'Thư mục chính'}); 
    }
    if(!folders.find(f=>f.id===currentFolderId)) currentFolderId = folders[0].id;
    
    renderFolders(); renderFiles(); renderHistory(); 
}

function getAll(s) { return new Promise(r => db.transaction(s,'readonly').objectStore(s).getAll().onsuccess=e=>r(e.target.result||[])); }
function saveDB(s, i) { db.transaction(s,'readwrite').objectStore(s).put(i); }
function delDB(s, id) { db.transaction(s,'readwrite').objectStore(s).delete(id); }
function clearStore(s) { db.transaction(s, 'readwrite').objectStore(s).clear(); }

// --- INIT MAIN ---
function setupEvents() {
    // Bây giờ các hàm đã được định nghĩa ở trên, gán vào sự kiện sẽ an toàn
    els.btnNewFolder.onclick = createFolder;
    els.btnRenameFolder.onclick = renameFolder;
    els.btnDeleteFolder.onclick = deleteCurrentFolder;
    
    els.folderSelect.onchange = (e) => { currentFolderId = e.target.value; switchView(currentView); };
    
    els.btnViewFiles.onclick = () => switchView('manager');
    els.btnViewHistory.onclick = () => switchView('history');
    els.btnViewChecklist.onclick = () => switchView('checklist');
    
    els.searchInput.oninput = () => { 
        if (currentView === 'manager') renderFiles();
        if (currentView === 'history') renderHistory();
    };

    els.btnClearChecklist.onclick = clearChecklist;
    els.btnClearHistory.onclick = clearHistory;

    els.selectAll.onchange = (e) => { getFilteredFiles().forEach(f => f.selected = e.target.checked); renderFiles(); };
    
    els.btnDownloadBatch.onclick = downloadBatchZip;
    els.btnDownloadDirect.onclick = downloadBatchDirect;
    els.btnDeleteBatch.onclick = deleteBatch;

    els.historyFilters.forEach(btn => {
        btn.onclick = () => {
            els.historyFilters.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentFilter = btn.dataset.filter;
            renderHistory();
        };
    });

    document.addEventListener('keydown', e => {
        if(els.previewModal.classList.contains('show')) {
            if(e.key === 'ArrowLeft') prevChapter();
            if(e.key === 'ArrowRight') nextChapter();
            if(e.key === 'Escape') closePreview();
        }
    });
}

function switchView(v) { 
    currentView=v; 
    Object.values(els.views).forEach(e=>e.classList.remove('active')); 
    els.views[v].classList.add('active'); 
    [els.btnViewFiles, els.btnViewChecklist, els.btnViewHistory].forEach(b=>b.classList.remove('active')); 
    if(v==='manager') els.btnViewFiles.classList.add('active'); 
    if(v==='checklist') els.btnViewChecklist.classList.add('active'); 
    if(v==='history') els.btnViewHistory.classList.add('active'); 
    if(v==='manager') renderFiles(); 
    if(v==='history') renderHistory(); 
    if(v==='checklist') renderChecklist(); 
}

window.openPreview = (id) => { const f=files.find(x=>x.id===id); if(!f) return; previewFileId=id; els.previewTitle.innerText=f.name; els.previewDocHeader.innerText=f.name.replace('.docx',''); let c=""; if(f.segments) f.segments.forEach(s=>s.lines.forEach(l=>c+=`<p>${l}</p>`)); else c="<p>...</p>"; els.previewBody.innerHTML=c; els.previewModal.classList.add('show'); };
window.closePreview = () => els.previewModal.classList.remove('show');
window.deleteOne = (id) => { if(confirm('Xóa file?')) { delDB('files', id); files=files.filter(f=>f.id!==id); renderFiles(); } };
function deleteBatch() { const s=getFilteredFiles().filter(f=>f.selected); if(confirm(`Xóa ${s.length} file?`)) { s.forEach(f=>delDB('files',f.id)); files=files.filter(f=>!f.selected || f.folderId!==currentFolderId); renderFiles(); } }
function downloadBatchZip() { const s=getFilteredFiles().filter(f=>f.selected); if(!s.length) return toast("Chưa chọn"); const z=new JSZip(); s.forEach(f=>z.file(f.name, f.blob)); z.generateAsync({type:"blob"}).then(c=>saveAs(c,`Batch_${Date.now()}.zip`)); }
async function downloadBatchDirect() { const s=getFilteredFiles().filter(f=>f.selected); if(!s.length) return toast("Chưa chọn"); for(let f of s) { if(f.blob) { saveAs(f.blob, f.name); await new Promise(r=>setTimeout(r,300)); } } }
function generateDocxFromSegments(h, s) { const { Document, Packer, Paragraph, TextRun } = docx; const c = []; c.push(new Paragraph({children:[new TextRun({text:h, size:32, font:"Calibri"})], spacing:{after:240}})); s.forEach(seg=>{ seg.lines.forEach(l=>{ c.push(new Paragraph({children:[new TextRun({text:l, size:32, font:"Calibri"})], spacing:{after:240}})); }); }); return Packer.toBlob(new Document({sections:[{children:c}]})); }

// START APP
async function init() {
    await initDB();
    setupEvents();
    
    // Channel listener
    commChannel.onmessage = (event) => {
        const data = event.data;
        if (!data) return;
        if (data.type === 'MERGE') performMerge(data.payload);
        if (data.type === 'CHECKLIST') importChecklist(data.payload);
    };
    
    window.addEventListener('visibilitychange', () => {
        if (!document.hidden && currentView === 'manager') renderFiles();
    });
}

init();
