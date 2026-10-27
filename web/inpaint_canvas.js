import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

app.registerExtension({
    name: "RFNodes.InpaintCanvas",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        // 元プロンプトノード: image_path が接続されているとき、実行結果(読み取ったプロンプト)を入力欄に書き出す
        if (nodeData.name === "RFPromptCarrierNode") {
            const origCarrierExecuted = nodeType.prototype.onExecuted;
            nodeType.prototype.onExecuted = function (message) {
                if (origCarrierExecuted) origCarrierExecuted.apply(this, arguments);
                const t = message && message.text;
                if (t == null) return;
                const linked = this.inputs && this.inputs.some((i) => i.name === "image_path" && i.link != null);
                if (!linked) return;
                const text = Array.isArray(t) ? String(t.length ? t[t.length - 1] : "") : String(t);
                const w = this.widgets && this.widgets.find((x) => x.name === "prompt_text");
                if (!w) return;
                w.value = text;
                if (w.inputEl) w.inputEl.value = text;
                this.setDirtyCanvas(true, true);
            };
            return;
        }

        if (nodeData.name !== "RFInpaintCanvasNode") return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            if (onNodeCreated) onNodeCreated.apply(this, arguments);

            const node = this;
            const imgWidget = this.widgets.find((w) => w.name === "image");
            const maskWidget = this.widgets.find((w) => w.name === "mask_data");

            // ComfyUI標準の画像プレビューを無効化（キャンバスと二重表示になるため）
            Object.defineProperty(this, "imgs", {
                get() { return undefined; },
                set(_) { /* 標準プレビューが画像を入れようとしても無視する */ },
                configurable: true,
            });
            // 標準の「画像に合わせてノードをリサイズ」を止める
            this.setSizeForImage = function () {};

            const removePreviewWidget = () => {
                if (!node.widgets) return;
                const before = node.widgets.length;
                node.widgets = node.widgets.filter(
                    (w) => !(w.name && w.name.includes("canvas-image-preview"))
                );
                if (node.widgets.length !== before) node.setDirtyCanvas(true, true);
            };
            removePreviewWidget();
            setTimeout(removePreviewWidget, 100);
            setTimeout(removePreviewWidget, 500);

            if (maskWidget) {
                maskWidget.type = "hidden";
                maskWidget.draw = () => {};
                maskWidget.computeSize = () => [0, 0];
            }

            const container = document.createElement("div");
            Object.assign(container.style, {
                width: "100%",
                maxWidth: "100%",
                height: "100%",
                minHeight: "200px",
                display: "flex",
                flexDirection: "column",
                gap: "4px",
                boxSizing: "border-box",
                padding: "2px",
                overflow: "clip"
            });

            const toolbar = document.createElement("div");
            Object.assign(toolbar.style, {
                display: "flex",
                alignItems: "center",
                gap: "6px",
                width: "100%",
                flex: "none",
                fontSize: "11px",
                color: "#ccc"
            });

            const modeBtn = document.createElement("button");
            modeBtn.textContent = "Mode: Brush";
            Object.assign(modeBtn.style, {
                flex: "1",
                height: "22px",
                background: "#2a2a38",
                border: "1px solid #4a4a5e",
                color: "#eee",
                borderRadius: "3px",
                cursor: "pointer",
                fontSize: "11px"
            });

            const undoBtn = document.createElement("button");
            undoBtn.textContent = "Undo";
            Object.assign(undoBtn.style, {
                height: "22px",
                padding: "0 8px",
                background: "#2a2a38",
                border: "1px solid #4a4a5e",
                color: "#eee",
                borderRadius: "3px",
                cursor: "pointer",
                fontSize: "11px"
            });

            const clearBtn = document.createElement("button");
            clearBtn.textContent = "Clear";
            Object.assign(clearBtn.style, {
                height: "22px",
                padding: "0 8px",
                background: "#3a2020",
                border: "1px solid #6a3535",
                color: "#eee",
                borderRadius: "3px",
                cursor: "pointer",
                fontSize: "11px"
            });

            const sizeSlider = document.createElement("input");
            sizeSlider.type = "range";
            sizeSlider.min = "4";
            sizeSlider.max = "120";
            sizeSlider.value = "32";
            Object.assign(sizeSlider.style, {
                width: "70px",
                cursor: "pointer"
            });

            toolbar.appendChild(modeBtn);
            toolbar.appendChild(sizeSlider);
            toolbar.appendChild(undoBtn);
            toolbar.appendChild(clearBtn);

            // キャンバスを収める領域（ノードの余り領域いっぱいに広がる）
            const stage = document.createElement("div");
            Object.assign(stage.style, {
                flex: "1 1 0",
                minHeight: "0",
                minWidth: "0",
                width: "100%",
                position: "relative",
                overflow: "clip"
            });

            const canvas = document.createElement("canvas");
            Object.assign(canvas.style, {
                display: "block",
                position: "absolute",
                left: "50%",
                top: "50%",
                transform: "translate(-50%, -50%)",
                touchAction: "none",
                userSelect: "none",
                backgroundColor: "#111116",
                borderRadius: "4px",
                outline: "1px solid #333342",
                cursor: "crosshair"
            });

            stage.appendChild(canvas);
            container.appendChild(toolbar);
            container.appendChild(stage);

            // 最小高さは固定値。ノードの高さには依存させない（無限伸長の防止）
            const domWidget = this.addDOMWidget("canvas_ui", "customcanvas", container, {
                getValue: () => (maskWidget ? maskWidget.value : ""),
                setValue: (v) => {},
                getMinHeight: () => 240
            });

            const maskBuffer = document.createElement("canvas");
            let isDrawing = false;
            let currentMode = "brush";
            let currentImg = null;
            let historyStack = [];
            let lastLockedImage = imgWidget ? imgWidget.value : "";

            // stage の領域に、アスペクト比を保ったまま最大サイズで収める
            const fitCanvas = () => {
                const sw = stage.clientWidth;
                const sh = stage.clientHeight;
                if (!sw || !sh || !canvas.width || !canvas.height) return;
                const scale = Math.min(sw / canvas.width, sh / canvas.height);
                canvas.style.width = `${Math.floor(canvas.width * scale)}px`;
                canvas.style.height = `${Math.floor(canvas.height * scale)}px`;
            };

            const resizeObserver = new ResizeObserver(() => fitCanvas());
            resizeObserver.observe(stage);

            const render = () => {
                const ctx = canvas.getContext("2d");
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                if (currentImg) {
                    ctx.drawImage(currentImg, 0, 0, canvas.width, canvas.height);
                }
                ctx.save();
                ctx.globalAlpha = 0.65;
                ctx.drawImage(maskBuffer, 0, 0, canvas.width, canvas.height);
                ctx.restore();
            };

            const pushHistory = () => {
                if (maskBuffer.width === 0 || maskBuffer.height === 0) return;
                const mCtx = maskBuffer.getContext("2d");
                if (historyStack.length >= 25) historyStack.shift();
                historyStack.push(mCtx.getImageData(0, 0, maskBuffer.width, maskBuffer.height));
            };

            const syncMask = () => {
                if (!maskWidget) return;
                if (maskBuffer.width === 0 || maskBuffer.height === 0) {
                    maskWidget.value = "";
                    return;
                }
                maskWidget.value = maskBuffer.toDataURL("image/png");
            };

            const undo = () => {
                if (historyStack.length === 0) return;
                const mCtx = maskBuffer.getContext("2d");
                const prev = historyStack.pop();
                mCtx.putImageData(prev, 0, 0);
                render();
                syncMask();
            };

            undoBtn.onclick = (e) => {
                e.preventDefault();
                undo();
            };

            clearBtn.onclick = (e) => {
                e.preventDefault();
                pushHistory();
                const mCtx = maskBuffer.getContext("2d");
                mCtx.clearRect(0, 0, maskBuffer.width, maskBuffer.height);
                render();
                syncMask();
            };

            modeBtn.onclick = () => {
                if (currentMode === "brush") {
                    currentMode = "eraser";
                    modeBtn.textContent = "Mode: Eraser";
                    modeBtn.style.background = "#3d2a38";
                } else {
                    currentMode = "brush";
                    modeBtn.textContent = "Mode: Brush";
                    modeBtn.style.background = "#2a2a38";
                }
            };

            const loadMaskFromData = (dataStr) => {
                if (!dataStr || !dataStr.startsWith("data:image")) return;
                const mImg = new Image();
                mImg.onload = () => {
                    const mCtx = maskBuffer.getContext("2d");
                    mCtx.clearRect(0, 0, maskBuffer.width, maskBuffer.height);
                    mCtx.drawImage(mImg, 0, 0, maskBuffer.width, maskBuffer.height);
                    render();
                };
                mImg.src = dataStr;
            };

            const setupDimensions = (w, h) => {
                const maxDim = 1024;
                let targetW = w;
                let targetH = h;
                if (targetW > maxDim || targetH > maxDim) {
                    if (targetW > targetH) {
                        targetH = Math.round((targetH * maxDim) / targetW);
                        targetW = maxDim;
                    } else {
                        targetW = Math.round((targetW * maxDim) / targetH);
                        targetH = maxDim;
                    }
                }
                canvas.width = targetW;
                canvas.height = targetH;
                maskBuffer.width = targetW;
                maskBuffer.height = targetH;
                fitCanvas();
            };

            // ---- 元画像のプロンプト(キャラ・作品名)を「元プロンプト」ノードへ書き出す ----
            // 画像を読み込むたびに、PNGのテキストチャンクからプロンプト文字列を取り出し、
            // グラフ上の RFPromptCarrierNode(画面で確認できる)へ書き込む。
            // そのノードは保存画像のメタデータに残るので、次のインペイントでも同じ流れで復元できる。
            const CARRIER_TYPE = "RFPromptCarrierNode";

            const metaInfo = document.createElement("div");
            Object.assign(metaInfo.style, {
                flex: "none",
                minWidth: "0",
                fontSize: "10px",
                padding: "0 2px",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                color: "#9aa"
            });
            container.insertBefore(metaInfo, stage);

            const readPngTextChunks = (buf) => {
                const u8 = new Uint8Array(buf);
                const sig = [137, 80, 78, 71, 13, 10, 26, 10];
                if (u8.length < 8 || sig.some((b, i) => u8[i] !== b)) return null;
                const dv = new DataView(buf);
                const dec = new TextDecoder("utf-8");
                const out = {};
                let off = 8;
                while (off + 12 <= u8.length) {
                    const len = dv.getUint32(off);
                    const type = String.fromCharCode(u8[off + 4], u8[off + 5], u8[off + 6], u8[off + 7]);
                    const start = off + 8;
                    const end = start + len;
                    if (end + 4 > u8.length) break;
                    if (type === "tEXt") {
                        const data = u8.subarray(start, end);
                        const z = data.indexOf(0);
                        if (z > 0) out[dec.decode(data.subarray(0, z))] = dec.decode(data.subarray(z + 1));
                    } else if (type === "iTXt") {
                        const data = u8.subarray(start, end);
                        const z = data.indexOf(0);
                        if (z > 0 && data[z + 1] === 0) { // 非圧縮のみ対応
                            const z2 = data.indexOf(0, z + 3);
                            const z3 = z2 >= 0 ? data.indexOf(0, z2 + 1) : -1;
                            if (z3 >= 0) out[dec.decode(data.subarray(0, z))] = dec.decode(data.subarray(z3 + 1));
                        }
                    }
                    if (type === "IEND") break;
                    off = end + 4;
                }
                return out;
            };

            const nonEmptyStr = (v) => typeof v === "string" && v.trim() !== "";

            const findOriginalInPrompt = (promptObj) => {
                if (!promptObj || typeof promptObj !== "object") return "";
                const nodes = Object.values(promptObj).filter(
                    (n) => n && typeof n === "object" && n.inputs && n.class_type !== CARRIER_TYPE
                );
                for (const n of nodes) {
                    if (n.class_type === "ImpactWildcardProcessor" && nonEmptyStr(n.inputs.populated_text)) {
                        return n.inputs.populated_text;
                    }
                }
                for (const n of nodes) {
                    for (const [k, v] of Object.entries(n.inputs)) {
                        if (k === "wildcard_text") continue;
                        if (typeof v === "string" && /1girl\s*,/.test(v)) return v;
                    }
                }
                return "";
            };

            const findOriginalInWorkflow = (wf) => {
                if (!wf || !Array.isArray(wf.nodes)) return "";
                const nodes = wf.nodes.filter((n) => n && n.type !== CARRIER_TYPE);
                for (const n of nodes) {
                    if (n.type === "ImpactWildcardProcessor" && Array.isArray(n.widgets_values) && nonEmptyStr(n.widgets_values[1])) {
                        return n.widgets_values[1];
                    }
                }
                for (const n of nodes) {
                    if (Array.isArray(n.widgets_values)) {
                        const hit = n.widgets_values.find(
                            (v) => typeof v === "string" && !v.startsWith("data:image") && /1girl\s*,/.test(v)
                        );
                        if (hit) return hit;
                    }
                }
                return "";
            };

            const extractA1111 = (paramStr) => {
                if (!nonEmptyStr(paramStr)) return "";
                const idx = paramStr.indexOf("Negative prompt:");
                const positive = idx !== -1 ? paramStr.slice(0, idx) : paramStr;
                return positive.trim();
            };

            const findCarrierInPrompt = (promptObj) => {
                if (!promptObj || typeof promptObj !== "object") return "";
                const nodes = Object.values(promptObj).filter(
                    (n) => n && typeof n === "object" && n.inputs && n.class_type === CARRIER_TYPE
                );
                for (const n of nodes) {
                    if (nonEmptyStr(n.inputs.prompt_text)) return n.inputs.prompt_text;
                }
                return "";
            };

            const findCarrierInWorkflow = (wf) => {
                if (!wf || !Array.isArray(wf.nodes)) return "";
                for (const n of wf.nodes) {
                    if (n && n.type === CARRIER_TYPE && Array.isArray(n.widgets_values)) {
                        const hit = n.widgets_values.find((v) => nonEmptyStr(v));
                        if (hit) return hit;
                    }
                }
                return "";
            };

            const findCarrier = () => {
                const list = (app.graph && app.graph._nodes) || [];
                return list.find((n) => n.type === CARRIER_TYPE) || null;
            };

            const createCarrier = () => {
                const LG = globalThis.LiteGraph;
                if (!LG || !app.graph) return null;
                const c = LG.createNode(CARRIER_TYPE);
                if (!c) return null;
                c.pos = [node.pos[0], node.pos[1] - 210];
                c.size = [Math.max(node.size[0], 420), 170];
                app.graph.add(c);
                return c;
            };

            const writeCarrier = (text, mode) => {
                let c = findCarrier();
                if (!c) {
                    if (mode !== "user" || !text) return false;
                    c = createCarrier();
                    if (!c) return false;
                }
                const w = c.widgets && c.widgets.find((x) => x.name === "prompt_text");
                if (!w) return false;
                if (mode === "user" || !nonEmptyStr(w.value)) {
                    w.value = text;
                    c.setDirtyCanvas(true, true);
                }
                return true;
            };

            const showMeta = (text, note) => {
                if (!text) {
                    metaInfo.textContent = note || "メタ: キャラ・作品名の情報なし";
                    metaInfo.style.color = "#c9a35a";
                    return;
                }
                const sanitized = text.replace(/[\r\n]+/g, " ").trim();
                const m = /1girl\s*,\s*([^,]+)\s*,\s*([^,]+)/.exec(sanitized);
                const head = m ? `${m[1].trim()} / ${m[2].trim()}` : sanitized.slice(0, 40);
                metaInfo.textContent = `元プロンプトを書き出し: ${head}`;
                metaInfo.style.color = "#8fc79a";
            };

            let metaReq = 0;
            const loadMeta = async (filename, mode) => {
                if (!filename) return;
                const req = ++metaReq;
                try {
                    const resp = await api.fetchApi(`/view?filename=${encodeURIComponent(filename)}&type=input`);
                    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                    const buf = await resp.arrayBuffer();
                    if (req !== metaReq) return;
                    const chunks = readPngTextChunks(buf);
                    let text = "";
                    let note = "";
                    if (!chunks) {
                        note = "メタ: PNG以外は引き継げません";
                    } else {
                        if (chunks.prompt) {
                            try { text = findOriginalInPrompt(JSON.parse(chunks.prompt)); } catch (e) {}
                        }
                        if (!text && chunks.workflow) {
                            try { text = findOriginalInWorkflow(JSON.parse(chunks.workflow)); } catch (e) {}
                        }
                        if (!text && chunks.parameters) {
                            text = extractA1111(chunks.parameters);
                        }
                        if (!text) {
                            const carrierSources = [
                                chunks.comfy_inpaint_prompt,
                                chunks.prompt,
                                chunks.comfy_workflow,
                                chunks.workflow
                            ];
                            for (const src of carrierSources) {
                                if (!src) continue;
                                try {
                                    const parsed = JSON.parse(src);
                                    text = findCarrierInPrompt(parsed) || findCarrierInWorkflow(parsed);
                                    if (text) break;
                                } catch (e) {}
                            }
                        }
                    }
                    const done = writeCarrier(text, mode);
                    if (text && !done && mode === "user") {
                        showMeta(text, "");
                        metaInfo.textContent += "（元プロンプトノードを作成できませんでした。ノードを手動で追加してください）";
                    } else {
                        showMeta(text, note);
                    }
                    node.setDirtyCanvas(true, true);
                } catch (err) {
                    console.warn("[RFNodes.InpaintCanvas] meta read failed:", err);
                    showMeta("", "メタ: 読み取りに失敗しました");
                }
            };

            const loadImage = (filename, mode = "user") => {
                if (!filename) return;
                lastLockedImage = filename;
                loadMeta(filename, mode);
                const img = new Image();
                img.crossOrigin = "anonymous";
                img.onload = () => {
                    currentImg = img;
                    setupDimensions(img.naturalWidth, img.naturalHeight);
                    render();
                    if (maskWidget && maskWidget.value) {
                        loadMaskFromData(maskWidget.value);
                    }
                };
                img.onerror = () => {
                    throw new Error(`Failed to load inpaint image: ${filename}`);
                };
                img.src = api.apiURL(`/view?filename=${encodeURIComponent(filename)}&type=input`);
            };

            if (imgWidget) {
                const origCb = imgWidget.callback;
                imgWidget.callback = function (v) {
                    if (origCb) origCb.apply(this, arguments);
                    removePreviewWidget();
                    loadImage(v || (imgWidget ? imgWidget.value : ""));
                };
            }

            const checkImageUpdate = () => {
                if (imgWidget && imgWidget.value && imgWidget.value !== lastLockedImage) {
                    loadImage(imgWidget.value);
                }
            };

            const origConfigure = this.onConfigure;
            this.onConfigure = function () {
                if (origConfigure) origConfigure.apply(this, arguments);
                if (imgWidget && imgWidget.value) {
                    loadImage(imgWidget.value, "init");
                }
            };

            const origExecuted = this.onExecuted;
            this.onExecuted = function () {
                if (origExecuted) origExecuted.apply(this, arguments);
                if (imgWidget && lastLockedImage && imgWidget.value !== lastLockedImage) {
                    imgWidget.value = lastLockedImage;
                }
            };

            const getPos = (e) => {
                const rect = canvas.getBoundingClientRect();
                return {
                    x: (e.clientX - rect.left) * (canvas.width / rect.width),
                    y: (e.clientY - rect.top) * (canvas.height / rect.height)
                };
            };

            const drawPoint = (x, y) => {
                const mCtx = maskBuffer.getContext("2d");
                mCtx.lineWidth = parseInt(sizeSlider.value, 10);
                mCtx.lineCap = "round";
                mCtx.lineJoin = "round";

                if (currentMode === "brush") {
                    mCtx.globalCompositeOperation = "source-over";
                    mCtx.fillStyle = "#ffffff";
                    mCtx.strokeStyle = "#ffffff";
                } else {
                    mCtx.globalCompositeOperation = "destination-out";
                }
                mCtx.lineTo(x, y);
                mCtx.stroke();
                mCtx.beginPath();
                mCtx.moveTo(x, y);
                render();
            };

            ["mousedown", "mouseup", "click", "dblclick", "pointerup"].forEach((t) => {
                canvas.addEventListener(t, (e) => e.stopPropagation());
            });

            canvas.addEventListener("pointerdown", (e) => {
                if (e.button !== 0) return;
                e.preventDefault();
                e.stopPropagation();
                pushHistory();
                isDrawing = true;
                const mCtx = maskBuffer.getContext("2d");
                mCtx.beginPath();
                const pos = getPos(e);
                drawPoint(pos.x, pos.y);
            });

            canvas.addEventListener("pointermove", (e) => {
                if (!isDrawing) return;
                e.preventDefault();
                e.stopPropagation();
                const pos = getPos(e);
                drawPoint(pos.x, pos.y);
            });

            const stopDrawing = () => {
                if (!isDrawing) return;
                isDrawing = false;
                const mCtx = maskBuffer.getContext("2d");
                mCtx.beginPath();
                syncMask();
            };

            canvas.addEventListener("pointerup", stopDrawing);
            canvas.addEventListener("pointerleave", stopDrawing);

            // ---- ブラシサイズ表示カーソル ----
            const brushCursor = document.createElement("div");
            Object.assign(brushCursor.style, {
                position: "fixed",
                left: "0px",
                top: "0px",
                width: "0px",
                height: "0px",
                pointerEvents: "none",
                zIndex: "10000",
                display: "none",
                boxSizing: "border-box",
                borderRadius: "50%",
                border: "1.5px solid rgba(255,255,255,0.95)",
                boxShadow: "0 0 0 1px rgba(0,0,0,0.65), inset 0 0 0 1px rgba(0,0,0,0.65)",
                transform: "translate(-50%, -50%)"
            });
            const brushLabel = document.createElement("div");
            Object.assign(brushLabel.style, {
                position: "absolute",
                top: "100%",
                left: "50%",
                transform: "translateX(-50%)",
                marginTop: "3px",
                fontSize: "10px",
                lineHeight: "1",
                whiteSpace: "nowrap",
                color: "#fff",
                textShadow: "0 0 3px #000, 0 0 3px #000",
                fontFamily: "sans-serif"
            });
            brushCursor.appendChild(brushLabel);
            document.body.appendChild(brushCursor);

            let lastPointer = null;
            const updateBrushCursor = (e) => {
                if (e) lastPointer = { x: e.clientX, y: e.clientY };
                if (!lastPointer) return;
                const rect = canvas.getBoundingClientRect();
                if (!rect.width || !canvas.width) return;
                const size = parseInt(sizeSlider.value, 10);
                // lineWidth は直径。画面上の直径 = size × 表示倍率
                const d = Math.max(4, size * (rect.width / canvas.width));
                brushCursor.style.width = `${d}px`;
                brushCursor.style.height = `${d}px`;
                brushCursor.style.left = `${lastPointer.x}px`;
                brushCursor.style.top = `${lastPointer.y}px`;
                brushCursor.style.borderStyle = currentMode === "eraser" ? "dashed" : "solid";
                // 元画像でのピクセル数に換算して表示
                const realScale = currentImg && canvas.width ? currentImg.naturalWidth / canvas.width : 1;
                brushLabel.textContent = `${Math.round(size * realScale)}px`;
            };

            canvas.addEventListener("pointerenter", (e) => {
                canvas.style.cursor = "none";
                brushCursor.style.display = "block";
                updateBrushCursor(e);
            });
            canvas.addEventListener("pointermove", (e) => updateBrushCursor(e));
            canvas.addEventListener("pointerleave", () => {
                brushCursor.style.display = "none";
                canvas.style.cursor = "crosshair";
            });
            // ホイールでブラシサイズ変更（キャンバス上ではComfyUIのズームを止める）
            canvas.addEventListener("wheel", (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (e.deltaY === 0) return;
                const cur = parseInt(sizeSlider.value, 10);
                const min = parseInt(sizeSlider.min, 10);
                const max = parseInt(sizeSlider.max, 10);
                let next;
                if (e.deltaY < 0) {
                    next = Math.max(cur + 1, Math.round(cur * 1.1)); // 上回し: 大きく
                } else {
                    next = Math.min(cur - 1, Math.round(cur / 1.1)); // 下回し: 小さく
                }
                next = Math.min(max, Math.max(min, next));
                sizeSlider.value = String(next);
                updateBrushCursor(e); // 円とpx表示に即反映
            }, { passive: false });
            sizeSlider.addEventListener("input", () => updateBrushCursor());
            modeBtn.addEventListener("click", () => updateBrushCursor());

            // ---- 画像ドロップ: workflowメタデータがあっても展開せず画像だけ読み込む ----
            const isOverThisNode = (e) => {
                try {
                    const t = e.target;
                    const overCanvas = t === app.canvas.canvas;
                    const overOurDom = t instanceof Node && container.contains(t);
                    if (!overCanvas && !overOurDom) return false;
                    const pos = app.canvas.convertEventToCanvasOffset(e);
                    return node.isPointInside(pos[0], pos[1]);
                } catch (err) {
                    return false;
                }
            };

            const hasImage = (e) => {
                const dt = e.dataTransfer;
                if (!dt) return false;
                if (dt.items && dt.items.length) {
                    return Array.from(dt.items).some(
                        (it) => it.kind === "file" && it.type.startsWith("image/")
                    );
                }
                return Array.from(dt.files || []).some((f) => f.type.startsWith("image/"));
            };

            const uploadDroppedImage = async (file) => {
                try {
                    const body = new FormData();
                    body.append("image", file);
                    body.append("type", "input");
                    const resp = await api.fetchApi("/upload/image", { method: "POST", body });
                    if (!resp.ok) {
                        throw new Error(`Upload failed: ${resp.status} ${resp.statusText}`);
                    }
                    const data = await resp.json();
                    const name = data.subfolder ? `${data.subfolder}/${data.name}` : data.name;
                    if (!imgWidget) return;

                    const values = imgWidget.options && imgWidget.options.values;
                    if (Array.isArray(values) && !values.includes(name)) values.push(name);

                    // 新しい画像なので、前のマスクと履歴はリセット
                    if (maskWidget) maskWidget.value = "";
                    historyStack = [];

                    imgWidget.value = name;
                    if (imgWidget.callback) imgWidget.callback(name);
                    node.setDirtyCanvas(true, true);
                } catch (err) {
                    console.error("[RFNodes.InpaintCanvas] drop upload error:", err);
                    window.alert(`画像の読み込みに失敗しました: ${err.message}`);
                }
            };

            // window の capture で受けるので、ComfyUI標準のドロップ処理(workflow展開)より先に動く
            const onWindowDragOver = (e) => {
                if (!hasImage(e) || !isOverThisNode(e)) return;
                e.preventDefault();
                e.stopPropagation();
                if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
            };
            const onWindowDrop = (e) => {
                if (!hasImage(e) || !isOverThisNode(e)) return;
                const file = Array.from(e.dataTransfer.files || []).find((f) =>
                    f.type.startsWith("image/")
                );
                if (!file) return;
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                uploadDroppedImage(file);
            };
            window.addEventListener("dragover", onWindowDragOver, true);
            window.addEventListener("drop", onWindowDrop, true);

            // ---- 生成結果を確認して、選んだものだけ次のインペイントの入力にする ----
            const resultsBar = document.createElement("div");
            Object.assign(resultsBar.style, {
                display: "none",
                flex: "none",
                alignItems: "center",
                gap: "4px",
                overflowX: "auto",
                padding: "2px 0",
                fontSize: "10px",
                color: "#ccc"
            });
            container.insertBefore(resultsBar, stage);

            const makeBtn = (text, bg, border) => {
                const b = document.createElement("button");
                b.textContent = text;
                Object.assign(b.style, {
                    flex: "none",
                    height: "22px",
                    padding: "0 8px",
                    background: bg || "#2a2a38",
                    border: `1px solid ${border || "#4a4a5e"}`,
                    color: "#eee",
                    borderRadius: "3px",
                    cursor: "pointer",
                    fontSize: "11px"
                });
                return b;
            };

            let currentResults = [];
            let selectedIndex = -1;
            let usingResult = false;
            let lightbox = null;
            let lightboxKeyHandler = null;

            const resultUrl = (info) => {
                const q = new URLSearchParams({
                    filename: info.filename,
                    subfolder: info.subfolder || "",
                    type: info.type || "output"
                });
                return `/view?${q.toString()}`;
            };

            const closeLightbox = () => {
                if (lightboxKeyHandler) {
                    window.removeEventListener("keydown", lightboxKeyHandler, true);
                    lightboxKeyHandler = null;
                }
                if (lightbox) {
                    lightbox.remove();
                    lightbox = null;
                }
            };

            let refreshBar = () => {};

            const useResultAsInput = async (info) => {
                if (usingResult) return;
                usingResult = true;
                refreshBar();
                try {
                    const resp = await api.fetchApi(resultUrl(info));
                    if (!resp.ok) throw new Error(`Fetch failed: ${resp.status}`);
                    const blob = await resp.blob();
                    const file = new File([blob], info.filename, { type: blob.type || "image/png" });
                    await uploadDroppedImage(file); // inputへコピーして image に設定（マスクはリセット）
                    closeLightbox();
                } catch (err) {
                    console.error("[RFNodes.InpaintCanvas] use result error:", err);
                    window.alert(`結果画像を入力にできませんでした: ${err.message}`);
                } finally {
                    usingResult = false;
                    refreshBar();
                }
            };

            // 大きく表示して全部確認する（← → / Esc 対応）
            const openLightbox = (startIndex) => {
                if (!currentResults.length) return;
                closeLightbox();
                let idx = Math.min(Math.max(startIndex, 0), currentResults.length - 1);

                lightbox = document.createElement("div");
                Object.assign(lightbox.style, {
                    position: "fixed",
                    inset: "0",
                    zIndex: "10001",
                    background: "rgba(0,0,0,0.88)",
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: "10px",
                    fontFamily: "sans-serif"
                });
                const bigImg = document.createElement("img");
                Object.assign(bigImg.style, {
                    maxWidth: "92vw",
                    maxHeight: "80vh",
                    objectFit: "contain",
                    borderRadius: "4px",
                    background: "#111116"
                });
                const controls = document.createElement("div");
                Object.assign(controls.style, {
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    color: "#eee",
                    fontSize: "13px"
                });
                const prevBtn = makeBtn("◀");
                const nextBtn = makeBtn("▶");
                const counter = document.createElement("span");
                const useBtnL = makeBtn("この画像を入力に使う", "#2a3a2e", "#4f7a5a");
                const closeBtnL = makeBtn("閉じる");
                [prevBtn, nextBtn, useBtnL, closeBtnL].forEach((b) => { b.style.height = "28px"; b.style.fontSize = "13px"; });
                controls.append(prevBtn, counter, nextBtn, useBtnL, closeBtnL);
                lightbox.append(bigImg, controls);

                const show = (i) => {
                    const n = currentResults.length;
                    idx = (i + n) % n;
                    selectedIndex = idx; // 見ている画像を選択状態にしておく
                    bigImg.src = api.apiURL(resultUrl(currentResults[idx]));
                    counter.textContent = `${idx + 1} / ${n}`;
                    refreshBar();
                };
                prevBtn.onclick = () => show(idx - 1);
                nextBtn.onclick = () => show(idx + 1);
                closeBtnL.onclick = closeLightbox;
                useBtnL.onclick = () => useResultAsInput(currentResults[idx]);
                lightbox.addEventListener("click", (e) => {
                    if (e.target === lightbox) closeLightbox();
                });

                lightboxKeyHandler = (e) => {
                    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeLightbox(); }
                    else if (e.key === "ArrowLeft") { e.preventDefault(); e.stopPropagation(); show(idx - 1); }
                    else if (e.key === "ArrowRight") { e.preventDefault(); e.stopPropagation(); show(idx + 1); }
                };
                window.addEventListener("keydown", lightboxKeyHandler, true);

                document.body.appendChild(lightbox);
                show(idx);
            };

            refreshBar = () => {
                resultsBar.innerHTML = "";
                if (!currentResults.length) {
                    resultsBar.style.display = "none";
                    return;
                }
                const label = document.createElement("span");
                label.textContent = "結果:";
                label.style.flex = "none";
                resultsBar.appendChild(label);

                currentResults.forEach((info, i) => {
                    const t = document.createElement("img");
                    t.src = api.apiURL(resultUrl(info));
                    t.title = `クリック: 選択 / ダブルクリック: 拡大 (${i + 1}/${currentResults.length})`;
                    const selected = i === selectedIndex;
                    Object.assign(t.style, {
                        height: "52px",
                        flex: "none",
                        borderRadius: "3px",
                        outline: selected ? "3px solid #ff9ad0" : "1px solid #4a4a5e",
                        outlineOffset: selected ? "-1px" : "0",
                        cursor: "pointer"
                    });
                    t.addEventListener("click", () => {
                        selectedIndex = selectedIndex === i ? -1 : i; // もう一度押すと選択解除
                        refreshBar();
                    });
                    t.addEventListener("dblclick", () => openLightbox(i));
                    resultsBar.appendChild(t);
                });

                const viewBtn = makeBtn("全て確認");
                viewBtn.onclick = () => openLightbox(selectedIndex >= 0 ? selectedIndex : 0);

                const useBtn = makeBtn(
                    usingResult ? "処理中…" : "選択を入力に使う",
                    "#2a3a2e",
                    "#4f7a5a"
                );
                const canUse = selectedIndex >= 0 && !usingResult;
                useBtn.disabled = !canUse;
                useBtn.style.opacity = canUse ? "1" : "0.4";
                useBtn.style.cursor = canUse ? "pointer" : "default";
                useBtn.onclick = () => {
                    if (selectedIndex >= 0) useResultAsInput(currentResults[selectedIndex]);
                };

                const dismissBtn = makeBtn("×");
                dismissBtn.title = "どれも使わない（結果バーを閉じる）";
                dismissBtn.onclick = () => {
                    currentResults = [];
                    selectedIndex = -1;
                    closeLightbox();
                    refreshBar();
                };

                resultsBar.append(viewBtn, useBtn, dismissBtn);
                resultsBar.style.display = "flex";
            };

            const showResults = (images) => {
                currentResults = Array.isArray(images) ? images : [];
                selectedIndex = -1; // 新しい結果が来たら選択はリセット
                closeLightbox();
                refreshBar();
            };

            // 保存ノードの実行結果(画像情報)を受け取る
            const RESULT_NODE_TYPES = ["RFSaveImagePreserveMeta", "SaveImage"];
            const onResultExecuted = (ev) => {
                const d = ev.detail;
                if (!d || !d.output || !Array.isArray(d.output.images)) return;
                let n = null;
                try {
                    n = app.graph.getNodeById(d.node) || app.graph.getNodeById(parseInt(d.node, 10));
                } catch (err) {
                    n = null;
                }
                const type = n && (n.type || n.comfyClass);
                if (!type || !RESULT_NODE_TYPES.includes(type)) return;
                showResults(d.output.images);
            };
            api.addEventListener("executed", onResultExecuted);

            // ---- タイマー/リスナー/Observerはノード削除時に解除 ----
            const intervalId = setInterval(checkImageUpdate, 500);

            const onKeyDown = (e) => {
                if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !e.shiftKey) {
                    if (container.matches(":hover") || node.is_selected) {
                        e.preventDefault();
                        e.stopPropagation();
                        undo();
                    }
                }
            };
            window.addEventListener("keydown", onKeyDown);

            const origRemoved = this.onRemoved;
            this.onRemoved = function () {
                clearInterval(intervalId);
                window.removeEventListener("keydown", onKeyDown);
                window.removeEventListener("dragover", onWindowDragOver, true);
                window.removeEventListener("drop", onWindowDrop, true);
                api.removeEventListener("executed", onResultExecuted);
                closeLightbox();
                brushCursor.remove();
                resizeObserver.disconnect();
                if (origRemoved) origRemoved.apply(this, arguments);
            };

            setTimeout(() => {
                this.setSize([Math.max(this.size[0], 520), Math.max(this.size[1], 580)]);
                if (imgWidget && imgWidget.value) {
                    loadImage(imgWidget.value, "init");
                }
            }, 60);
        };
    }
});