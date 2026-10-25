import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

app.registerExtension({
    name: "RFNodes.InpaintCanvas",
    async beforeRegisterNodeDef(nodeType, nodeData) {
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
                height: "100%",
                minHeight: "200px",
                display: "flex",
                flexDirection: "column",
                gap: "4px",
                boxSizing: "border-box",
                padding: "2px"
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
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                overflow: "hidden"
            });

            const canvas = document.createElement("canvas");
            Object.assign(canvas.style, {
                display: "block",
                flex: "none",
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

            const loadImage = (filename) => {
                if (!filename) return;
                lastLockedImage = filename;
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
                    loadImage(imgWidget.value);
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
                resizeObserver.disconnect();
                if (origRemoved) origRemoved.apply(this, arguments);
            };

            setTimeout(() => {
                this.setSize([Math.max(this.size[0], 520), Math.max(this.size[1], 580)]);
                if (imgWidget && imgWidget.value) {
                    loadImage(imgWidget.value);
                }
            }, 60);
        };
    }
});