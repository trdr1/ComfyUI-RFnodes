import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

app.registerExtension({
    name: "RFNodes.RegionSwapper",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "RFRegionSwapperNode") return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            if (onNodeCreated) onNodeCreated.apply(this, arguments);

            const node = this;

            const container = document.createElement("div");
            Object.assign(container.style, {
                width: "100%",
                maxWidth: "100%",
                height: "100%",
                minHeight: "360px",
                display: "flex",
                flexDirection: "column",
                gap: "4px",
                boxSizing: "border-box",
                padding: "4px",
                fontFamily: "sans-serif",
                color: "#eee",
                overflow: "clip"
            });

            const topBar = document.createElement("div");
            Object.assign(topBar.style, {
                display: "flex",
                flexDirection: "column",
                gap: "6px",
                flex: "none",
                fontSize: "11px"
            });

            const row1 = document.createElement("div");
            Object.assign(row1.style, {
                display: "flex",
                gap: "6px",
                alignItems: "center",
                width: "100%"
            });

            const sessionSelect = document.createElement("select");
            Object.assign(sessionSelect.style, {
                flex: "1 1 auto",
                minWidth: "0",
                height: "26px",
                background: "#181822",
                border: "1px solid #3c3c4f",
                color: "#ddd",
                borderRadius: "3px",
                fontSize: "11px",
                padding: "0 6px"
            });

            const refreshBtn = document.createElement("button");
            refreshBtn.textContent = "🔄 読込";

            const row2 = document.createElement("div");
            Object.assign(row2.style, {
                display: "flex",
                gap: "6px",
                alignItems: "center",
                width: "100%"
            });

            const resetBtn = document.createElement("button");
            resetBtn.textContent = "↩ 元画像";
            const saveBtn = document.createElement("button");
            saveBtn.textContent = "💾 確定保存";
            const sendInputBtn = document.createElement("button");
            sendInputBtn.textContent = "🚀 入力に送る";
            const dlBtn = document.createElement("button");
            dlBtn.textContent = "📥 見たまま保存";
            const fixBtn = document.createElement("button");
            fixBtn.textContent = "🛠 修復";
            fixBtn.title = "ノードの大きさが崩れたとき、標準サイズに戻す";

            [refreshBtn, resetBtn, saveBtn, sendInputBtn, dlBtn, fixBtn].forEach((b) => {
                Object.assign(b.style, {
                    flex: "1 1 0",
                    height: "26px",
                    padding: "0 4px",
                    background: "#2a2a38",
                    border: "1px solid #4a4a5e",
                    color: "#eee",
                    borderRadius: "3px",
                    cursor: "pointer",
                    fontSize: "11px",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis"
                });
            });
            refreshBtn.style.flex = "0 0 70px";
            fixBtn.style.flex = "0 0 70px";
            saveBtn.style.background = "#24422e";
            saveBtn.style.borderColor = "#437a54";
            sendInputBtn.style.background = "#233348";
            sendInputBtn.style.borderColor = "#3d587a";

            row1.appendChild(sessionSelect);
            row1.appendChild(refreshBtn);
            row1.appendChild(fixBtn);

            row2.appendChild(resetBtn);
            row2.appendChild(saveBtn);
            row2.appendChild(sendInputBtn);
            row2.appendChild(dlBtn);

            topBar.appendChild(row1);
            topBar.appendChild(row2);

            const statusLabel = document.createElement("div");
            Object.assign(statusLabel.style, {
                fontSize: "10px",
                color: "#8fc79a",
                overflow: "hidden",
                whiteSpace: "nowrap",
                textOverflow: "ellipsis",
                padding: "2px 0"
            });

            const stage = document.createElement("div");
            Object.assign(stage.style, {
                flex: "1 1 0",
                minHeight: "0",
                minWidth: "0",
                width: "100%",
                overflow: "clip",
                background: "#111116",
                borderRadius: "4px",
                outline: "1px solid #333342",
                position: "relative"
            });

            const canvas = document.createElement("canvas");
            Object.assign(canvas.style, {
                display: "block",
                position: "absolute",
                top: "0",
                right: "0",
                bottom: "0",
                left: "0",
                margin: "auto",
                maxWidth: "100%",
                maxHeight: "100%",
                touchAction: "none",
                userSelect: "none",
                cursor: "pointer"
            });

            stage.appendChild(canvas);
            container.appendChild(topBar);
            container.appendChild(statusLabel);
            container.appendChild(stage);

            // ボタン・セレクト等の操作が本体(ノード選択・リサイズ処理)へ漏れないようにする
            ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick"].forEach((t) => {
                container.addEventListener(t, (e) => e.stopPropagation());
            });

            this.addDOMWidget("region_swapper_ui", "customswapper", container, {
                getValue: () => "",
                setValue: () => {},
                getMinHeight: () => 360
            });

            let currentSession = null;
            let origImageEl = null;
            let maskImageEl = null;
            let candidateImages = [];
            let regions = [];
            let sessionList = [];

            // 表示サイズはCSS(max-width/max-height + margin:auto)で決まる。JSでは触らない
            const fitCanvas = () => {};

            const resizeObserver = new ResizeObserver(() => fitCanvas());
            resizeObserver.observe(stage);

            const extractConnectedComponents = (mImg) => {
                const off = document.createElement("canvas");
                off.width = mImg.naturalWidth;
                off.height = mImg.naturalHeight;
                const ctx = off.getContext("2d");
                ctx.drawImage(mImg, 0, 0);
                const idata = ctx.getImageData(0, 0, off.width, off.height);
                const data = idata.data;
                const w = off.width;
                const h = off.height;
                const visited = new Uint8Array(w * h);

                const foundRegions = [];
                const step = 2;

                for (let y = 0; y < h; y += step) {
                    for (let x = 0; x < w; x += step) {
                        const idx = y * w + x;
                        if (visited[idx]) continue;
                        if (data[idx * 4] > 64) {
                            let minX = x;
                            let maxX = x;
                            let minY = y;
                            let maxY = y;
                            let count = 0;

                            const queue = [idx];
                            visited[idx] = 1;

                            while (queue.length > 0) {
                                const curr = queue.pop();
                                const cy = Math.floor(curr / w);
                                const cx = curr % w;
                                count++;

                                if (cx < minX) minX = cx;
                                if (cx > maxX) maxX = cx;
                                if (cy < minY) minY = cy;
                                if (cy > maxY) maxY = cy;

                                const neighbors = [];
                                if (cy > 0) neighbors.push((cy - 1) * w + cx);
                                if (cy < h - 1) neighbors.push((cy + 1) * w + cx);
                                if (cx > 0) neighbors.push(cy * w + (cx - 1));
                                if (cx < w - 1) neighbors.push(cy * w + (cx + 1));

                                for (const n of neighbors) {
                                    if (!visited[n] && data[n * 4] >= 128) {
                                        visited[n] = 1;
                                        queue.push(n);
                                    }
                                }
                            }

                            if (count > 80) {
                                const pad = 12;
                                foundRegions.push({
                                    bbox: [
                                        Math.max(0, minX - pad),
                                        Math.max(0, minY - pad),
                                        Math.min(w, maxX + pad),
                                        Math.min(h, maxY + pad)
                                    ],
                                    candidate_idx: 0
                                });
                            }
                        }
                    }
                }
                return foundRegions;
            };

            const render = (clean = false) => {
                if (!origImageEl || !canvas.width || !canvas.height) return;
                const ctx = canvas.getContext("2d");
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                ctx.drawImage(origImageEl, 0, 0, canvas.width, canvas.height);

                regions.forEach((r) => {
                    const [x1, y1, x2, y2] = r.bbox;
                    const bw = x2 - x1;
                    const bh = y2 - y1;

                    if (r.candidate_idx > 0) {
                        const cImg = candidateImages[r.candidate_idx - 1];
                        if (cImg) {
                            ctx.drawImage(cImg, x1, y1, bw, bh, x1, y1, bw, bh);
                        }
                    }

                    if (clean) return;

                    ctx.save();
                    ctx.strokeStyle = r.candidate_idx === 0 ? "rgba(255, 180, 0, 0.9)" : "rgba(80, 240, 120, 0.95)";
                    ctx.lineWidth = Math.max(2, Math.floor(canvas.width / 400));
                    ctx.strokeRect(x1, y1, bw, bh);

                    ctx.fillStyle = "rgba(0, 0, 0, 0.75)";
                    const badgeText = r.candidate_idx === 0 ? "元画像" : `生成 #${r.candidate_idx}`;
                    ctx.font = "bold 13px sans-serif";
                    const tw = ctx.measureText(badgeText).width;
                    ctx.fillRect(x1, Math.max(0, y1 - 20), tw + 10, 20);

                    ctx.fillStyle = r.candidate_idx === 0 ? "#ffd54f" : "#a5d6a7";
                    ctx.fillText(badgeText, x1 + 5, Math.max(14, y1 - 5));
                    ctx.restore();
                });
            };

            const toUrl = (viewParam) => {
                const q = new URLSearchParams({
                    filename: viewParam.filename,
                    subfolder: viewParam.subfolder || "",
                    type: viewParam.type || "output"
                });
                return api.apiURL(`/view?${q.toString()}`);
            };

            const loadSession = async (session) => {
                if (!session) return;
                currentSession = session;
                statusLabel.textContent = `読込中: ${session.label}`;

                const loadSingle = (url, label) => new Promise((resolve, reject) => {
                    const img = new Image();
                    img.crossOrigin = "anonymous";
                    img.onload = () => resolve(img);
                    img.onerror = () => reject(new Error(`${label}の読込に失敗しました (${url})`));
                    img.src = url;
                });

                try {
                    const origUrl = toUrl(session.orig_view);
                    const maskUrl = toUrl(session.mask_view);

                    origImageEl = await loadSingle(origUrl, "元画像");
                    maskImageEl = await loadSingle(maskUrl, "マスク画像");

                    const candidateUrls = (session.result_views || []).map((v) => toUrl(v));
                    candidateImages = await Promise.all(
                        candidateUrls.map((u, idx) => loadSingle(u, `修正候補#${idx + 1}`))
                    );

                    canvas.width = origImageEl.naturalWidth;
                    canvas.height = origImageEl.naturalHeight;
                    fitCanvas();

                    regions = extractConnectedComponents(maskImageEl);
                    render();
                    statusLabel.textContent = `表示中: ${session.label} (検出領域: ${regions.length})`;
                } catch (err) {
                    statusLabel.textContent = `読込エラー: ${err.message}`;
                    throw err;
                }
            };

            const getTargetFolder = () => {
                const w = node.widgets && node.widgets.find((x) => x.name === "target_folder");
                return (w && w.value) ? String(w.value).trim() : "inpaint_results";
            };

            const fetchSessions = async () => {
                const folder = getTargetFolder();
                try {
                    const res = await fetch(`/rf_nodes/latest_inpaint_sessions?folder=${encodeURIComponent(folder)}&limit=25`);
                    if (!res.ok) {
                        const errTxt = await res.text();
                        throw new Error(`HTTP ${res.status}: ${errTxt}`);
                    }
                    const data = await res.json();
                    sessionList = data.sessions || [];
                    sessionSelect.innerHTML = "";
                    sessionList.forEach((s, idx) => {
                        const opt = document.createElement("option");
                        opt.value = String(idx);
                        opt.textContent = s.label;
                        sessionSelect.appendChild(opt);
                    });
                    if (sessionList.length > 0) {
                        await loadSession(sessionList[0]);
                    } else {
                        statusLabel.textContent = `対象フォルダ (${folder}) にマスク画像が見つかりません`;
                    }
                } catch (e) {
                    statusLabel.textContent = `セッション取得失敗: ${e.message}`;
                    throw e;
                }
            };

            sessionSelect.addEventListener("change", () => {
                const idx = parseInt(sessionSelect.value, 10);
                if (sessionList[idx]) loadSession(sessionList[idx]);
            });

            refreshBtn.addEventListener("click", () => fetchSessions());

            resetBtn.addEventListener("click", () => {
                regions.forEach((r) => { r.candidate_idx = 0; });
                render();
            });

            const performSaveComposed = async () => {
                if (!currentSession) throw new Error("セッションが読み込まれていません");
                const payload = {
                    mask_path: currentSession.mask_path,
                    assignments: regions.map((r) => ({
                        bbox: r.bbox,
                        candidate_idx: r.candidate_idx
                    }))
                };
                const res = await fetch("/rf_nodes/save_composed_image", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload)
                });
                if (!res.ok) {
                    const errText = await res.text();
                    throw new Error(errText);
                }
                const resData = await res.json();
                return resData.result;
            };

            saveBtn.addEventListener("click", async () => {
                saveBtn.disabled = true;
                saveBtn.textContent = "保存中…";
                try {
                    const result = await performSaveComposed();
                    statusLabel.textContent = `保存完了: ${result.filename}`;
                } catch (e) {
                    statusLabel.textContent = `保存失敗: ${e.message}`;
                    throw e;
                } finally {
                    saveBtn.disabled = false;
                    saveBtn.textContent = "💾 確定保存";
                }
            });

            sendInputBtn.addEventListener("click", async () => {
                sendInputBtn.disabled = true;
                sendInputBtn.textContent = "転送中…";
                try {
                    const targetCanvasNode = app.graph && app.graph._nodes && app.graph._nodes.find((n) => n.type === "RFInpaintCanvasNode");
                    if (!targetCanvasNode) {
                        throw new Error("ワークフロー内に RFInpaintCanvasNode（インペイント入力ノード）が見つかりません");
                    }

                    const savedResult = await performSaveComposed();
                    const viewUrl = api.apiURL(
                        `/view?filename=${encodeURIComponent(savedResult.filename)}&subfolder=${encodeURIComponent(savedResult.subfolder || "")}&type=output`
                    );

                    const imgResp = await fetch(viewUrl);
                    if (!imgResp.ok) throw new Error(`合成画像の取得に失敗しました: HTTP ${imgResp.status}`);
                    const blob = await imgResp.blob();
                    const file = new File([blob], savedResult.filename, { type: blob.type || "image/png" });

                    const formData = new FormData();
                    formData.append("image", file);
                    formData.append("type", "input");

                    const upResp = await api.fetchApi("/upload/image", { method: "POST", body: formData });
                    if (!upResp.ok) throw new Error(`入力フォルダへのアップロードに失敗しました: HTTP ${upResp.status}`);
                    const upData = await upResp.json();
                    const uploadedName = upData.subfolder ? `${upData.subfolder}/${upData.name}` : upData.name;

                    const keepSize = [...targetCanvasNode.size];
                    const keepPos = [...targetCanvasNode.pos];
                    const restoreLayout = () => {
                        targetCanvasNode.pos = [...keepPos];
                        if (targetCanvasNode.size[0] !== keepSize[0] || targetCanvasNode.size[1] !== keepSize[1]) {
                            targetCanvasNode.setSize([...keepSize]);
                        }
                        app.graph.setDirtyCanvas(true, true);
                    };

                    const imgWidget = targetCanvasNode.widgets && targetCanvasNode.widgets.find((w) => w.name === "image");
                    if (imgWidget) {
                        const values = imgWidget.options && imgWidget.options.values;
                        if (Array.isArray(values) && !values.includes(uploadedName)) {
                            values.push(uploadedName);
                        }
                        imgWidget.value = uploadedName;
                        if (typeof targetCanvasNode.rfLoadImage === "function") {
                            targetCanvasNode.rfLoadImage(uploadedName);
                        } else if (imgWidget.callback) {
                            imgWidget.callback(uploadedName);
                        }
                    }

                    const maskWidget = targetCanvasNode.widgets && targetCanvasNode.widgets.find((w) => w.name === "mask_data");
                    if (maskWidget) maskWidget.value = "";

                    targetCanvasNode.setDirtyCanvas(true, true);
                    app.graph.setDirtyCanvas(true, true);
                    [0, 150, 600].forEach((ms) => setTimeout(restoreLayout, ms));
                    statusLabel.textContent = `入力へ転送完了: ${uploadedName} (元プロンプト引き継ぎ済)`;
                } catch (e) {
                    statusLabel.textContent = `転送失敗: ${e.message}`;
                    throw e;
                } finally {
                    sendInputBtn.disabled = false;
                    sendInputBtn.textContent = "🚀 入力に送る";
                }
            });

            const stepRegionCandidate = (r, forward) => {
                const totalCount = candidateImages.length + 1;
                if (forward) {
                    r.candidate_idx = (r.candidate_idx + 1) % totalCount;
                } else {
                    r.candidate_idx = (r.candidate_idx - 1 + totalCount) % totalCount;
                }
            };

            const findHitRegion = (clientX, clientY) => {
                if (!canvas.width || !canvas.height || regions.length === 0) return null;
                const rect = canvas.getBoundingClientRect();
                const clickX = (clientX - rect.left) * (canvas.width / rect.width);
                const clickY = (clientY - rect.top) * (canvas.height / rect.height);

                for (const r of regions) {
                    const [x1, y1, x2, y2] = r.bbox;
                    if (clickX >= x1 && clickX <= x2 && clickY >= y1 && clickY <= y2) {
                        return r;
                    }
                }
                return null;
            };

            ["mousedown", "mouseup", "click", "dblclick", "pointerup", "pointermove"].forEach((t) => {
                canvas.addEventListener(t, (e) => e.stopPropagation());
            });

            // 枠・バッジなしの見たままの画像をPNGとして保存する
            const downloadClean = () => {
                if (!origImageEl) {
                    statusLabel.textContent = "保存できる画像がありません";
                    return;
                }
                render(true);
                canvas.toBlob((blob) => {
                    render();
                    if (!blob) {
                        statusLabel.textContent = "画像の書き出しに失敗しました";
                        return;
                    }
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = `collage_${Date.now()}.png`;
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                    setTimeout(() => URL.revokeObjectURL(url), 2000);
                    statusLabel.textContent = `ダウンロードしました: ${a.download}`;
                }, "image/png");
            };

            dlBtn.addEventListener("click", downloadClean);

            fixBtn.addEventListener("click", () => {
                const W = 540;
                const H = 460;
                node.setSize([W + 1, H + 1]);
                requestAnimationFrame(() => {
                    node.setSize([W, H]);
                    app.graph.setDirtyCanvas(true, true);
                    if (typeof rememberLayout === "function") rememberLayout();
                    statusLabel.textContent = "レイアウトを標準サイズに戻しました";
                });
            });

            canvas.addEventListener("contextmenu", (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (e.ctrlKey) downloadClean();
            });

            canvas.addEventListener("pointerdown", (e) => {
                if (e.button !== 0 && e.button !== 2) return;
                if (e.button === 2 && e.ctrlKey) return;
                const r = findHitRegion(e.clientX, e.clientY);
                if (!r) return;

                e.preventDefault();
                e.stopPropagation();

                const isForward = e.button === 0 && !e.shiftKey;
                stepRegionCandidate(r, isForward);
                render();
            });

            canvas.addEventListener("wheel", (e) => {
                if (e.deltaY === 0) return;
                const r = findHitRegion(e.clientX, e.clientY);
                if (!r) return;

                e.preventDefault();
                e.stopPropagation();

                const isForward = e.deltaY < 0;
                stepRegionCandidate(r, isForward);
                render();
            }, { passive: false });

            const onApiExecuted = (e) => {
                const d = e && e.detail;
                if (!d || !d.output) return;
                fetchSessions();
            };
            api.addEventListener("executed", onApiExecuted);

            // ---- ノードの大きさ・位置が勝手に変わったら戻す安全装置 ----
            // ユーザー自身がグラフ上でドラッグしている間は何もしない
            let goodSize = null;
            let goodPos = null;
            let userDragging = false;
            let guardAlive = true;
            let warned = false;

            const rememberLayout = () => {
                goodSize = [...node.size];
                goodPos = [...node.pos];
            };

            const onWinPointerDown = (e) => {
                if (app.canvas && e.target === app.canvas.canvas) userDragging = true;
            };
            const onWinPointerUp = () => {
                if (!userDragging) return;
                userDragging = false;
                requestAnimationFrame(rememberLayout);
            };
            window.addEventListener("pointerdown", onWinPointerDown, true);
            window.addEventListener("pointerup", onWinPointerUp, true);

            const origConfigure = this.onConfigure;
            this.onConfigure = function () {
                if (origConfigure) origConfigure.apply(this, arguments);
                rememberLayout();
                requestAnimationFrame(rememberLayout);
            };

            const guardLoop = () => {
                if (!guardAlive) return;
                if (goodSize && goodPos && !userDragging) {
                    const changed =
                        Math.abs(node.size[0] - goodSize[0]) > 0.5 ||
                        Math.abs(node.size[1] - goodSize[1]) > 0.5 ||
                        Math.abs(node.pos[0] - goodPos[0]) > 0.5 ||
                        Math.abs(node.pos[1] - goodPos[1]) > 0.5;
                    if (changed) {
                        if (!warned) {
                            warned = true;
                            console.warn(
                                "[RFNodes.RegionSwapper] ノードの大きさ/位置が外部要因で変わったため元に戻しました",
                                { size: [...node.size], pos: [...node.pos], goodSize, goodPos }
                            );
                        }
                        node.pos = [...goodPos];
                        node.setSize([...goodSize]);
                        app.graph.setDirtyCanvas(true, true);
                    }
                }
                requestAnimationFrame(guardLoop);
            };

            const origRemoved = this.onRemoved;
            this.onRemoved = function () {
                guardAlive = false;
                window.removeEventListener("pointerdown", onWinPointerDown, true);
                window.removeEventListener("pointerup", onWinPointerUp, true);
                api.removeEventListener("executed", onApiExecuted);
                resizeObserver.disconnect();
                if (origRemoved) origRemoved.apply(this, arguments);
            };

            setTimeout(() => {
                this.setSize([Math.max(this.size[0], 540), Math.max(this.size[1], 460)]);
                rememberLayout();
                guardLoop();
                fetchSessions();
            }, 60);
        };
    }
});