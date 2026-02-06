// CONFIG V28
const DB_NAME = 'GopChuongPro_V28'; 
const DB_VERSION = 5;
let db = null;
let files = [];
let folders = [];
let historyLogs = [];
let checklists = {}; 
let currentFolderId = 'root';
let currentView = 'manager';
let previewFileId = null;

// --- DOM ELEMENTS ---
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
    toast: document.getElementById('toast'),
    btnClearHistory: document.getElementById('btnClearHistory')
};

// --- INIT ---
async function init() {
    await initDB();
    
    // SỰ KIỆN QUAN TRỌNG: Tự động làm mới khi tab hiện lên
    // Giải quyết triệt để vấn đề "Phải F5 mới thấy"
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") {
            // Load lại data từ DB để đảm bảo đồng bộ với những gì Worker đã làm ngầm
            loadData().then(() => {
                console.log("🔄 Auto-refreshing UI...");
                renderFiles();
                renderChecklist();
                renderHistory();
            });
        }
    });

    els.btnNewFolder.onclick = createFolder;
    els.btnDeleteFolder.onclick = deleteCurrentFolder;
    els.folderSelect.onchange = (e) => { currentFolderId = e.target.value; reloadAllViews(); };
    
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
    els.btnClearHistory.onclick = clearHistory;

    // SỰ KIỆN GỘP (Được trigger bởi Tampermonkey)
    els.btnMerge.onclick = async () => {
        const title = els.chapterTitle.value;
        const content = els.editor.value;
        const autoGroup = els.autoGroup.checked;
        
        // Clear ngay lập tức
        els.editor.value = ''; 
        
        await performMerge(title, content, autoGroup);
    };
    
    // Keyboard shortcuts for Preview
    document.addEventListener('keydown', e => {
        if(els.previewModal.classList.contains('show')) {
            if(e.key === 'ArrowLeft') prevChapter();
            if(e.key === 'ArrowRight') nextChapter();
            if(e.key === 'Escape') closePreview();
        }
    });
}

function reloadAllViews() {
    renderFiles();
    renderChecklist();
    renderHistory();
}

// --- MERGE LOGIC (Direct & Fast) ---
async function performMerge(inputTitle, content, autoGroup) {
    if (!content.trim()) return;

    let safeName = inputTitle.replace(/[:*?"<>|]/g, " -").trim();
    let fileName = `${safeName}.docx`;
    const lines = content.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    
    // Regex tìm số chương
    const match = inputTitle.match(/(?:Chương|Chapter|Hồi)\s*(\d+(\.\d+)?)/i);
    const chapterNum = match ? parseFloat(match[1]) : 999999;

    let segment = { idSort: chapterNum, lines: lines, header: inputTitle };

    if (autoGroup && match) {
        fileName = `Chương ${match[1].split('.')[0]}.docx`; // Gộp theo phần nguyên (Chương 1.1, 1.2 -> Chương 1.docx)
    }

    let targetFile = files.find(f => f.name === fileName && f.folderId === currentFolderId);

    if (targetFile) {
        // APPEND MODE (Nối tiếp)
        if (!targetFile.segments) targetFile.segments = [];
        
        // Check xem đoạn này đã có trong file chưa (tránh trùng lặp khi F2 nhiều lần)
        const exists = targetFile.segments.find(s => s.header === inputTitle);
        
        if (exists) {
            // Update nội dung cũ
            exists.lines = lines;
            addToLog(`Cập nhật nội dung: ${inputTitle}`, 'warn');
        } else {
            // Thêm mới
            targetFile.segments.push(segment);
            addToLog(`Đã gộp: ${inputTitle} vào ${fileName}`, 'success');
        }

        // Sắp xếp lại các đoạn trong file
        targetFile.segments.sort((a,b) => a.idSort - b.idSort);
        
        // Rebuild Info
        let allText = "";
        targetFile.segments.forEach(seg => { allText += seg.lines.join('\n') + '\n'; });

        targetFile.headerInDoc = targetFile.name.replace('.docx','');
        targetFile.wordCount = countWords(targetFile.headerInDoc + " " + allText);
        targetFile.timestamp = Date.now();
        
        // Generate Blob
        targetFile.blob = await generateDocxFromSegments(targetFile.headerInDoc, targetFile.segments);
        saveDB('files', targetFile);
        
    } else {
        // CREATE NEW FILE
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
        
        addToLog(`Tạo file mới: ${fileName}`, 'info');
    }

    // UPDATE UI (Nếu đang xem thì update luôn)
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
        const newItems = JSON.parse(raw); // [{title, num}]
        
        let currentList = checklists[currentFolderId] || [];
        
        // Merge list: Chỉ thêm cái chưa có
        let added = 0;
        newItems.forEach(newItem => {
            if(!currentList.find(x => x.num === newItem.num)) {
                currentList.push(newItem);
                added++;
            }
        });

        // Sort
        currentList.sort((a,b) => a.num - b.num);
        checklists[currentFolderId] = currentList;
        saveDB('checklists', {folderId: currentFolderId, list: currentList});

        if(added > 0) addToLog(`Đã thêm ${added} chương vào danh sách theo dõi.`, 'success');
        
        // Chuyển view để xem kết quả
        switchView('checklist');
        renderChecklist();
        toast(`Đã cập nhật danh sách (${currentList.length} chương)`);

    } catch(e) { console.error(e); }
}

function clearChecklist() {
    if(confirm("Xóa danh sách theo dõi của thư mục này?")) {
        delete checklists[currentFolderId];
        delDB('checklists', currentFolderId);
        renderChecklist();
    }
}

function renderChecklist() {
    const list = checklists[currentFolderId] || [];
    const currentFiles = files.filter(f => f.folderId === currentFolderId);
    
    // Tạo Set các chương đã có để tra cứu cho nhanh
    const doneChapters = new Set();
    currentFiles.forEach(f => {
        if(f.segments) f.segments.forEach(s => doneChapters.add(s.idSort));
        else doneChapters.add(getChapterNum(f.name));
    });

    els.checklistBody.innerHTML = '';
    
    if(list.length === 0) {
        els.checklistBody.innerHTML = '<div class="empty-state" style="padding:20px; text-align:center; color:#94a3b8;">Chưa có dữ liệu danh sách.</div>';
        els.progCount.innerText = "0/0";
        els.progBar.style.width = "0%";
        return;
    }

    const frag = document.createDocumentFragment();
    let doneCount = 0;

    list.forEach(item => {
        const isDone = doneChapters.has(item.num);
        if(isDone) doneCount++;
        
        const div = document.createElement('div');
        div.className = `cl-item ${isDone ? 'done' : ''}`;
        div.innerHTML = `
            <div class="col-status" style="width:120px; font-weight:700; color:${isDone?'#16a34a':'#94a3b8'}">
                ${isDone ? '✔ Đã gộp' : '○ Chưa gộp'}
            </div>
            <div class="col-title" style="flex:1">${item.title}</div>
            <div class="col-num" style="width:80px; text-align:right; font-family:monospace">#${item.num}</div>
        `;
        frag.appendChild(div);
    });
    els.checklistBody.appendChild(frag);

    els.progCount.innerText = `${doneCount}/${list.length}`;
    const percent = (doneCount / list.length) * 100;
    els.progBar.style.width = `${percent}%`;
}

// --- HISTORY LOGIC (Lưu 100 cái mỗi Folder) ---
function addToLog(msg, type = 'success') {
    const now = new Date();
    const time = now.toLocaleTimeString('vi-VN', {hour:'2-digit', minute:'2-digit', second:'2-digit'});
    
    const logItem = { 
        id: Date.now() + Math.random(), 
        folderId: currentFolderId, 
        time: time, 
        msg: msg, 
        type: type,
        timestamp: now.getTime()
    };
    
    historyLogs.unshift(logItem); // Thêm vào đầu
    saveDB('history', logItem);
    
    // Logic Clean up: Giữ 100 log mới nhất của Folder này
    const folderLogs = historyLogs.filter(l => l.folderId === currentFolderId);
    if (folderLogs.length > 100) {
        // Tìm log cũ nhất của folder này để xóa
        const sorted = folderLogs.sort((a,b) => a.timestamp - b.timestamp); // Cũ -> Mới
        const toDelete = sorted[0]; // Cái cũ nhất
        
        // Xóa khỏi RAM
        historyLogs = historyLogs.filter(l => l.id !== toDelete.id);
        // Xóa khỏi DB
        delDB('history', toDelete.id);
    }

    if(currentView === 'history') renderHistory();
}

function renderHistory() {
    const keyword = els.searchInput.value.toLowerCase();
    const filterType = els.historyFilter.value; 
    
    // 1. Lọc theo Folder hiện tại
    let filtered = historyLogs.filter(log => log.folderId === currentFolderId);
    
    // 2. Lọc theo Keyword & Type
    filtered = filtered.filter(log => {
        const matchSearch = log.msg.toLowerCase().includes(keyword);
        if (filterType === 'all') return matchSearch;
        return matchSearch && log.type === filterType;
    });

    els.historyTableBody.innerHTML = '';
    
    if (filtered.length === 0) {
         els.historyTableBody.innerHTML = '<tr><td colspan="3" style="text-align:center; padding: 20px; color:#94a3b8">Không có lịch sử nào.</td></tr>';
         return;
    }

    const frag = document.createDocumentFragment();
    filtered.forEach(log => {
        const tr = document.createElement('tr');
        let badgeClass = log.type; 
        let label = log.type === 'error' ? 'LỖI' : (log.type === 'warn' ? 'UPDATE' : 'OK');
        
        if (log.type === 'info') { badgeClass = 'info'; label = 'INFO'; }

        tr.innerHTML = `
            <td style="width: 100px;">${log.time}</td>
            <td style="width: 100px;"><span class="badge ${badgeClass}">${label}</span></td>
            <td>${log.msg}</td>
        `;
        frag.appendChild(tr);
    });
    els.historyTableBody.appendChild(frag);
}

function clearHistory() {
    if(confirm("Xóa toàn bộ lịch sử của thư mục này?")) {
        // Xóa trong RAM
        const toKeep = historyLogs.filter(l => l.folderId !== currentFolderId);
        const toDelete = historyLogs.filter(l => l.folderId === currentFolderId);
        
        historyLogs = toKeep;
        
        // Xóa trong DB
        toDelete.forEach(l => delDB('history', l.id));
        
        renderHistory();
    }
}

// --- HELPER FUNC ---
function countWords(text) { if (!text || !text.trim()) return 0; return text.trim().split(/\s+/).length; }
function generateDocxFromSegments(mainHeader, segments) { const { Document, Packer, Paragraph, TextRun } = docx; const children = []; children.push(new Paragraph({children: [new TextRun({text: mainHeader, font: "Calibri", size: 32, color: "000000"})], spacing: {after: 240}})); children.push(new Paragraph({text: "", spacing: {after: 240}})); segments.forEach(seg => { seg.lines.forEach(line => { children.push(new Paragraph({children: [new TextRun({text: line, font: "Calibri", size: 32, color: "000000"})], spacing: {after: 240}})); }); }); return Packer.toBlob(new Document({sections:[{children}]})); }

// --- DB CORE ---
function initDB() { return new Promise(r => { const q = indexedDB.open(DB_NAME, DB_VERSION); q.onupgradeneeded = e => { const d = e.target.result; if(!d.objectStoreNames.contains('files')) d.createObjectStore('files', {keyPath: 'id'}); if(!d.objectStoreNames.contains('folders')) d.createObjectStore('folders', {keyPath: 'id'}); if(!d.objectStoreNames.contains('history')) d.createObjectStore('history', {keyPath: 'id'}); if(!d.objectStoreNames.contains('checklists')) d.createObjectStore('checklists', {keyPath: 'folderId'}); }; q.onsuccess = e => { db = e.target.result; loadData().then(r); }; }); }
async function loadData() { files = await getAll('files'); folders = await getAll('folders'); historyLogs = (await getAll('history')).sort((a,b)=>b.timestamp-a.timestamp); const cl = await getAll('checklists'); cl.forEach(i => checklists[i.folderId] = i.list); if(!folders.find(f=>f.id==='root')) { folders.push({id:'root', name:'Thư mục chính'}); saveDB('folders', {id:'root', name:'Thư mục chính'}); } }
function getAll(s) { return new Promise(r => db.transaction(s,'readonly').objectStore(s).getAll().onsuccess=e=>r(e.target.result||[])); }
function saveDB(s, i) { db.transaction(s,'readwrite').objectStore(s).put(i); }
function delDB(s, id) { db.transaction(s,'readwrite').objectStore(s).delete(id); }

// --- UI HELPERS ---
function createFolder() { const n = prompt("Tên thư mục mới:"); if(n) { const f = {id: Date.now().toString(), name: n}; folders.push(f); saveDB('folders', f); currentFolderId = f.id; renderFolders(); reloadAllViews(); } }
function deleteCurrentFolder() { if(currentFolderId === 'root') return alert("Không thể xóa thư mục gốc"); if(confirm("Xóa thư mục này và toàn bộ file trong đó?")) { files.filter(f=>f.folderId===currentFolderId).forEach(f=>delDB('files',f.id)); files = files.filter(f=>f.folderId!==currentFolderId); delDB('folders', currentFolderId); folders = folders.filter(f=>f.id!==currentFolderId); currentFolderId = 'root'; renderFolders(); reloadAllViews(); } }
function renderFolders() { els.folderSelect.innerHTML = ''; folders.forEach(f => { const opt = document.createElement('option'); opt.value = f.id; opt.innerText = f.name; if(f.id === currentFolderId) opt.selected = true; els.folderSelect.appendChild(opt); }); }
function getFilteredFiles() { let list = files.filter(f => f.folderId === currentFolderId); const k = els.searchInput.value.toLowerCase().trim(); if(k && currentView === 'manager') list = list.filter(f => f.name.toLowerCase().includes(k)); list.sort((a,b) => getChapterNum(a.name) - getChapterNum(b.name)); return list; }
function renderFiles() { const list = getFilteredFiles(); els.fileCount.innerText = list.length; els.fileGrid.innerHTML = ''; list.forEach(f => { const div = document.createElement('div'); div.className = `file-card ${f.selected?'selected':''}`; div.innerHTML = ` <div class="card-header"><input type="checkbox" class="chk" ${f.selected?'checked':''}><span style="font-size:20px">📄</span></div> <div class="file-name">${f.name}</div> <div class="file-info">${f.wordCount} chữ</div> <div class="card-actions"> <button class="btn-small view">Xem</button> <button class="btn-small del">Xóa</button> </div> `; div.querySelector('.chk').onclick=e=>{e.stopPropagation(); f.selected=e.target.checked; renderFiles();}; div.querySelector('.view').onclick=e=>{e.stopPropagation(); openPreview(f.id);}; div.querySelector('.del').onclick=e=>{e.stopPropagation(); deleteOne(f.id);}; div.onclick=e=>{ if(!e.target.closest('button') && !e.target.closest('input')) { f.selected=!f.selected; renderFiles(); } }; els.fileGrid.appendChild(div); }); }

// --- PREVIEW & DOWNLOAD ---
window.openPreview = (id) => { const f = files.find(x=>x.id===id); if(!f) return; previewFileId = id; const list = getFilteredFiles(); els.previewTitle.innerText = f.name; els.previewDocHeader.innerText = f.headerInDoc; let content = ""; if(f.segments) f.segments.forEach(seg => seg.lines.forEach(l => content += `<p>${l}</p>`)); els.previewBody.innerHTML = content; els.previewModal.classList.add('show'); };
window.closePreview = () => els.previewModal.classList.remove('show');
window.prevChapter = () => navChapter(-1);
window.nextChapter = () => navChapter(1);
function navChapter(d) { const l = getFilteredFiles(); const i = l.findIndex(x=>x.id===previewFileId); if(i!==-1 && l[i+d]) openPreview(l[i+d].id); }
function deleteOne(id) { if(confirm('Xóa file này?')) { delDB('files', id); files=files.filter(f=>f.id!==id); renderFiles(); } }
function deleteBatch() { const s = getFilteredFiles().filter(f=>f.selected); if(confirm(`Xóa ${s.length} file?`)) { s.forEach(f=>delDB('files',f.id)); files=files.filter(f=>!f.selected || f.folderId!==currentFolderId); renderFiles(); } }
function downloadBatchZip() { const s = getFilteredFiles().filter(f=>f.selected); if(!s.length) return toast("Chưa chọn file", 'danger'); const z = new JSZip(); s.forEach(f=>z.file(f.name, f.blob)); z.generateAsync({type:"blob"}).then(c=>saveAs(c, `Batch_${Date.now()}.zip`)); }
async function downloadBatchDirect() { const s = getFilteredFiles().filter(f=>f.selected); if(!s.length) return toast("Chưa chọn file", 'danger'); toast(`Đang tải ${s.length} file...`); for(let i=0;i<s.length;i++) { if(s[i].blob) { saveAs(s[i].blob, s[i].name); await new Promise(r=>setTimeout(r,200)); } } }
function switchView(view) { currentView = view; document.querySelectorAll('.nav-pill').forEach(b=>b.classList.remove('active')); document.querySelectorAll('.view-section').forEach(v=>v.classList.remove('active')); if(view==='manager'){els.btnViewFiles.classList.add('active');els.viewManager.classList.add('active');renderFiles();} else if(view==='history'){els.btnViewHistory.classList.add('active');els.viewHistory.classList.add('active');renderHistory();} else {els.btnViewChecklist.classList.add('active');els.viewChecklist.classList.add('active');renderChecklist();} }
function toast(m, type='success') { els.toast.innerText = m; els.toast.className = `toast show ${type}`; setTimeout(()=>els.toast.classList.remove('show'), 2000); }

init();
