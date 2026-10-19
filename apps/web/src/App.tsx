import React, { useState, useEffect, useRef, useCallback } from "react";
import { Upload, FileArchive, Activity, Terminal, Download, Trash2, Cpu, Clock, HardDrive, CheckCircle2, XCircle, Loader2 } from "lucide-react";

const API = "/api";

interface Detection {
  projectType: string; engine: string; confidence: number; framework?: string; frameworkVersion?: string;
  entryFiles: string[]; hasAndroid: boolean; hasWeb: boolean; requiredTools: string[]; notes: string[]; unsupportedReason?: string;
}
interface Job {
  id: string; filename: string; size: number; status: string; progress: number; createdAt: number; updatedAt: number;
  detection?: Detection; artifactPath?: string; artifactSize?: number; buildTimeMs?: number; shareLink?: string; error?: string; logs: string[];
}

const STATUS_COLOR: Record<string,string> = {
  uploaded: "text-slate-400", analyzing: "text-blue-400", queued: "text-amber-400",
  installing: "text-cyan-400", building: "text-indigo-400", signing: "text-purple-400",
  completed: "text-emerald-400", failed: "text-rose-400",
};

function formatBytes(b: number) {
  if (!b) return "0 B";
  const k = 1024; const sizes = ["B","KB","MB","GB"];
  const i = Math.floor(Math.log(b)/Math.log(k));
  return (b/Math.pow(k,i)).toFixed(1) + " " + sizes[i];
}
function formatTime(ms: number) { return (ms/1000).toFixed(1) + "s"; }

export default function App() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [current, setCurrent] = useState<Job | null>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [tools, setTools] = useState<any>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const esRef = useRef<EventSource | null>(null);

  const refreshJobs = useCallback(async () => {
    try { const r = await fetch(`${API}/jobs`); const data = await r.json(); setJobs(data); } catch {}
  }, []);

  useEffect(() => { refreshJobs(); fetch(`${API}/tools`).then(r=>r.json()).then(setTools).catch(()=>{}); }, [refreshJobs]);

  useEffect(() => {
    if (!current) return;
    if (esRef.current) esRef.current.close();
    const es = new EventSource(`${API}/jobs/${current.id}/events`);
    esRef.current = es;
    es.onmessage = (e) => {
      const job: Job = JSON.parse(e.data);
      setCurrent(job);
      setJobs(prev => prev.map(j => j.id === job.id ? job : j));
      if (job.status === "completed" || job.status === "failed") es.close();
    };
    es.onerror = () => { es.close(); };
    return () => es.close();
  }, [current?.id]);

  const uploadFile = async (file: File) => {
    setUploading(true); setUploadProgress(0);
    const form = new FormData();
    form.append("file", file);
    try {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${API}/jobs`);
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) setUploadProgress(Math.round(e.loaded/e.total*100)); };
      const res: any = await new Promise((resolve, reject) => {
        xhr.onload = () => resolve(JSON.parse(xhr.responseText));
        xhr.onerror = reject;
        xhr.send(form);
      });
      if (res.error) { alert(res.error + (res.details ? "\n" + res.details.join("\n") : "")); }
      else {
        const job = await (await fetch(`${API}/jobs/${res.jobId}`)).json();
        setCurrent(job); refreshJobs();
      }
    } catch (e: any) { alert("Upload failed: " + e.message); }
    setUploading(false);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDragging(false);
    const f = e.dataTransfer.files?.[0];
    if (f) uploadFile(f);
  };

  const deleteJob = async (id: string) => {
    await fetch(`${API}/jobs/${id}`, { method: "DELETE" });
    if (current?.id === id) setCurrent(null);
    refreshJobs();
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-indigo-950 text-slate-100">
      <header className="border-b border-slate-800/60 bg-slate-950/60 backdrop-blur sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-indigo-500 to-fuchsia-500 flex items-center justify-center">
              <Cpu size={20} />
            </div>
            <div>
              <h1 className="text-lg font-bold">Universal APK Builder</h1>
              <p className="text-xs text-slate-400">Build Android APK from any source ZIP</p>
            </div>
          </div>
          <div className="text-xs text-slate-500">{tools ? Object.entries(tools).filter(([,v])=>v).length + " tools available" : "loading..."}</div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8 grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Upload + status */}
        <section className="lg:col-span-2 space-y-6">
          <div
            onDragOver={(e)=>{e.preventDefault();setDragging(true);}}
            onDragLeave={()=>setDragging(false)}
            onDrop={onDrop}
            onClick={()=>fileInput.current?.click()}
            className={`glass rounded-2xl p-10 text-center cursor-pointer transition-all border-2 border-dashed ${dragging ? "border-indigo-400 bg-indigo-500/10" : "border-slate-700 hover:border-slate-500"}`}
          >
            <input ref={fileInput} type="file" accept=".zip" hidden onChange={(e)=>{const f=e.target.files?.[0]; if(f) uploadFile(f);}} />
            <Upload className="mx-auto mb-4 text-indigo-400" size={48} />
            <h2 className="text-xl font-semibold mb-1">Kéo thả file ZIP hoặc click để chọn</h2>
            <p className="text-sm text-slate-400">Hệ thống tự phân tích, nhận diện framework và build APK</p>
            {uploading && (
              <div className="mt-4">
                <div className="h-2 bg-slate-800 rounded-full overflow-hidden">
                  <div className="h-full bg-indigo-500 transition-all" style={{ width: `${uploadProgress}%` }} />
                </div>
                <p className="text-xs mt-2 text-slate-400">{uploadProgress}%</p>
              </div>
            )}
          </div>

          {current && (
            <div className="glass rounded-2xl p-6 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="font-semibold flex items-center gap-2"><FileArchive size={18} className="text-indigo-400" /> {current.filename}</h3>
                  <p className="text-xs text-slate-400">{formatBytes(current.size)} · {new Date(current.createdAt).toLocaleString()}</p>
                </div>
                <span className={`font-mono text-sm ${STATUS_COLOR[current.status] || "text-slate-400"}`}>{current.status.toUpperCase()}</span>
              </div>

              {/* Detection */}
              {current.detection && (
                <div className="bg-slate-900/60 rounded-xl p-4 space-y-2">
                  <div className="flex flex-wrap gap-2 items-center">
                    <span className="text-xs px-2 py-1 rounded bg-indigo-500/20 text-indigo-300">{current.detection.framework || current.detection.projectType}</span>
                    {current.detection.frameworkVersion && <span className="text-xs px-2 py-1 rounded bg-slate-700 text-slate-300">v{current.detection.frameworkVersion}</span>}
                    <span className="text-xs px-2 py-1 rounded bg-slate-700 text-slate-300">engine: {current.detection.engine}</span>
                    <span className="text-xs px-2 py-1 rounded bg-slate-700 text-slate-300">conf: {(current.detection.confidence*100).toFixed(0)}%</span>
                  </div>
                  {current.detection.notes?.length > 0 && (
                    <ul className="text-xs text-amber-300/80 list-disc list-inside">
                      {current.detection.notes.map((n,i)=><li key={i}>{n}</li>)}
                    </ul>
                  )}
                  {current.detection.unsupportedReason && (
                    <p className="text-sm text-rose-400">{current.detection.unsupportedReason}</p>
                  )}
                </div>
              )}

              {/* Progress */}
              <div>
                <div className="flex justify-between text-xs mb-1">
                  <span>Tiến trình</span><span>{current.progress}%</span>
                </div>
                <div className="h-2 bg-slate-800 rounded-full overflow-hidden">
                  <div className={`h-full transition-all ${current.status==="failed"?"bg-rose-500":"bg-gradient-to-r from-indigo-500 to-fuchsia-500"}`} style={{ width: `${current.progress}%` }} />
                </div>
              </div>

              {/* Result */}
              {current.status === "completed" && (
                <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-xl p-4 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <CheckCircle2 className="text-emerald-400" />
                    <div>
                      <p className="font-semibold text-emerald-300">Build thành công</p>
                      <p className="text-xs text-slate-400">
                        {current.artifactSize ? formatBytes(current.artifactSize) : ""} {current.buildTimeMs ? `· ${formatTime(current.buildTimeMs)}` : ""}
                      </p>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <a href={`${API}/jobs/${current.id}/download`} className="px-4 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-600 text-white text-sm font-semibold flex items-center gap-2">
                      <Download size={16} /> Tải APK
                    </a>
                    {current.shareLink && (
                      <a href={current.shareLink} target="_blank" rel="noreferrer" className="px-4 py-2 rounded-lg bg-indigo-500 hover:bg-indigo-600 text-white text-sm font-semibold flex items-center gap-2">
                        Link chia sẻ
                      </a>
                    )}
                  </div>
                </div>
              )}
              {current.status === "failed" && (
                <div className="bg-rose-500/10 border border-rose-500/30 rounded-xl p-4">
                  <div className="flex items-center gap-2 text-rose-300 font-semibold"><XCircle size={18} /> Build thất bại</div>
                  <p className="text-sm text-rose-200/80 mt-1">{current.error}</p>
                </div>
              )}

              {/* Logs */}
              <div>
                <div className="flex items-center gap-2 mb-2 text-sm text-slate-300"><Terminal size={16} /> Terminal log</div>
                <div className="bg-black/60 rounded-xl p-3 h-64 overflow-auto font-mono text-xs text-slate-300">
                  {(current.logs || []).map((l,i)=><div key={i} className="whitespace-pre-wrap">{l}</div>)}
                  {(!current.logs || current.logs.length===0) && <div className="text-slate-600">Chưa có log...</div>}
                </div>
              </div>
            </div>
          )}
        </section>

        {/* History sidebar */}
        <aside className="space-y-4">
          <div className="glass rounded-2xl p-4">
            <h3 className="font-semibold mb-3 flex items-center gap-2"><Activity size={16} className="text-indigo-400" /> Lịch sử build</h3>
            <div className="space-y-2 max-h-[70vh] overflow-auto">
              {jobs.length === 0 && <p className="text-xs text-slate-500">Chưa có job nào.</p>}
              {jobs.map(j => (
                <div key={j.id} onClick={()=>setCurrent(j)} className={`p-3 rounded-lg cursor-pointer border transition ${current?.id===j.id?"border-indigo-500 bg-indigo-500/10":"border-slate-800 hover:border-slate-600"}`}>
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium truncate max-w-[160px]">{j.filename}</span>
                    <span className={`text-xs ${STATUS_COLOR[j.status]}`}>{j.status}</span>
                  </div>
                  <div className="text-xs text-slate-500 mt-1 flex items-center gap-2">
                    <Clock size={11} /> {new Date(j.createdAt).toLocaleTimeString()}
                    {j.artifactSize && <><HardDrive size={11} /> {formatBytes(j.artifactSize)}</>}
                  </div>
                  <button onClick={(e)=>{e.stopPropagation();deleteJob(j.id);}} className="mt-1 text-xs text-rose-400 hover:text-rose-300 flex items-center gap-1"><Trash2 size={11}/> Xóa</button>
                </div>
              ))}
            </div>
          </div>

          <div className="glass rounded-2xl p-4">
            <h3 className="font-semibold mb-2 text-sm">Môi trường</h3>
            <div className="text-xs space-y-1">
              {tools && Object.entries(tools).map(([k,v]) => (
                <div key={k} className="flex justify-between">
                  <span className="text-slate-400">{k}</span>
                  <span className={v ? "text-emerald-400" : "text-rose-400"}>{v ? "✓" : "✗"}</span>
                </div>
              ))}
            </div>
          </div>
        </aside>
      </main>
    </div>
  );
}
