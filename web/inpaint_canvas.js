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

            if (maskWidget) {
                maskWidget.type = "hidden";
                maskWidget.computeSize = () => [0, -4];
            }

            const container = document.createElement("div");
            Object.assign(container.style, {
                width: "100%",
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
            sizeSlider.max = "100";
            sizeSlider.value = "28";
            Object.assign(sizeSlider.style, {
                width: "70px",
                cursor: "pointer"
            });

            toolbar.appendChild(modeBtn);
            toolbar.appendChild(sizeSlider);
            toolbar.appendChild(clearBtn);

            this.imgs = null;
            const origDrawBg = this.onDrawBackground;
            this.onDrawBackground = function (ctx) {
                this.imgs = null;
                if (origDrawBg) origDrawBg.apply(this, arguments);
            };

            const canvasWrap = document.createElement("div");
            Object.assign(canvasWrap.style, {
                position: "relative",
                width: "100%",
                height: "460px",
                backgroundColor: "#111116",
                borderRadius: "4px",
                overflow: "hidden",
                border: "1px solid #333342"
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

            toolbar.insertBefore(undoBtn, clearBtn);

            const bgCanvas = document.createElement("canvas");
            const maskCanvas = document.createElement("canvas");
            const cursorCanvas = document.createElement("canvas");

            [bgCanvas, maskCanvas, cursorCanvas].forEach((c) => {
                Object.assign(c.style, {
                    position: "absolute",
                    left: "0",
                    top: "0"
                });
                canvasWrap.appendChild(c);
            });
            cursorCanvas.style.pointerEvents = "none";

            container.appendChild(toolbar);
            container.appendChild(canvasWrap);

            const domWidget = this.addDOMWidget("canvas_ui", "customcanvas", container, {
                getValue: () => (maskWidget ? maskWidget.value : ""),
                setValue: (v) => {}
            });

            let isDrawing = false;
            let currentMode = "brush";
            let currentImg = null;
            let historyStack = [];
            let lastLockedImage = imgWidget ? imgWidget.value : "";

            const pushHistory = () => {
                if (maskCanvas.width === 0 || maskCanvas.height === 0) return;
                const ctx = maskCanvas.getContext("2d");
                if (historyStack.length >= 30) historyStack.shift();
                historyStack.push(ctx.getImageData(0, 0, maskCanvas.width, maskCanvas.height));
            };

            const undo = () => {
                if (historyStack.length === 0) return;
                const ctx = maskCanvas.getContext("2d");
                const prev = historyStack.pop();
                ctx.putImageData(prev, 0, 0);
                syncMaskValue();
            };

            undoBtn.onclick = (e) => {
                e.preventDefault();
                undo();
            };

            const updateCanvasLayout = () => {
                if (!currentImg || currentImg.naturalWidth === 0) return;
                const wrapW = canvasWrap.clientWidth || (node.size[0] - 20);
                const wrapH = canvasWrap.clientHeight || 460;
                const imgW = currentImg.naturalWidth;
                const imgH = currentImg.naturalHeight;
                const aspect = imgW / imgH;

                let renderW = wrapW;
                let renderH = wrapW / aspect;
                if (renderH > wrapH) {
                    renderH = wrapH;
                    renderW = wrapH * aspect;
                }

                const offX = Math.max(0, (wrapW - renderW) / 2);
                const offY = Math.max(0, (wrapH - renderH) / 2);

                [bgCanvas, maskCanvas, cursorCanvas].forEach((c) => {
                    c.style.width = `${renderW}px`;
                    c.style.height = `${renderH}px`;
                    c.style.left = `${offX}px`;
                    c.style.top = `${offY}px`;
                });
                cursorCanvas.width = maskCanvas.width;
                cursorCanvas.height = maskCanvas.height;
            };

            const resizeCanvases = (w, h) => {
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
                bgCanvas.width = targetW;
                bgCanvas.height = targetH;
                maskCanvas.width = targetW;
                maskCanvas.height = targetH;
                cursorCanvas.width = targetW;
                cursorCanvas.height = targetH;
            };

            const redrawBg = () => {
                if (!currentImg) return;
                resizeCanvases(currentImg.naturalWidth, currentImg.naturalHeight);
                const bgCtx = bgCanvas.getContext("2d");
                bgCtx.clearRect(0, 0, bgCanvas.width, bgCanvas.height);
                bgCtx.drawImage(currentImg, 0, 0, bgCanvas.width, bgCanvas.height);
                updateCanvasLayout();
            };

            const loadMaskFromData = (dataStr) => {
                if (!dataStr || !dataStr.startsWith("data:image")) return;
                const mImg = new Image();
                mImg.onload = () => {
                    const ctx = maskCanvas.getContext("2d");
                    ctx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
                    ctx.drawImage(mImg, 0, 0, maskCanvas.width, maskCanvas.height);
                };
                mImg.src = dataStr;
            };



            const adjustSizeAndLayout = () => {
                let fixedHeight = 80;
                for (const w of node.widgets) {
                    if (w === domWidget) continue;
                    if (w.computeSize) {
                        const sz = w.computeSize(node.size[0]);
                        fixedHeight += (sz && sz[1] > 0) ? sz[1] + 4 : 24;
                    } else {
                        fixedHeight += 24;
                    }
                }
                const availH = Math.max(200, node.size[1] - fixedHeight);
                canvasWrap.style.height = `${availH}px`;
                domWidget.computeSize = (width) => [width, availH + 40];
                updateCanvasLayout();
            };

            const origOnResize = this.onResize;
            this.onResize = function (size) {
                if (origOnResize) origOnResize.apply(this, arguments);
                adjustSizeAndLayout();
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

            const syncMaskValue = () => {
                if (!maskWidget) return;
                if (maskCanvas.width === 0 || maskCanvas.height === 0) {
                    maskWidget.value = "";
                    return;
                }
                maskWidget.value = maskCanvas.toDataURL("image/png");
                app.graph.setDirtyCanvas(true, true);
            };

            clearBtn.onclick = () => {
                pushHistory();
                const ctx = maskCanvas.getContext("2d");
                ctx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
                syncMaskValue();
            };

            const getCanvasPos = (e) => {
                const rect = maskCanvas.getBoundingClientRect();
                const scaleX = maskCanvas.width / rect.width;
                const scaleY = maskCanvas.height / rect.height;
                return {
                    x: (e.clientX - rect.left) * scaleX,
                    y: (e.clientY - rect.top) * scaleY
                };
            };

            const drawCursor = (x, y) => {
                const cCtx = cursorCanvas.getContext("2d");
                cCtx.clearRect(0, 0, cursorCanvas.width, cursorCanvas.height);
                const radius = parseInt(sizeSlider.value, 10) / 2;
                cCtx.beginPath();
                cCtx.arc(x, y, radius, 0, Math.PI * 2);
                cCtx.strokeStyle = "rgba(255, 255, 255, 0.9)";
                cCtx.lineWidth = 1.5;
                cCtx.stroke();
                cCtx.beginPath();
                cCtx.arc(x, y, Math.max(0.5, radius - 1), 0, Math.PI * 2);
                cCtx.strokeStyle = "rgba(0, 0, 0, 0.7)";
                cCtx.lineWidth = 1;
                cCtx.stroke();
            };

            const clearCursor = () => {
                const cCtx = cursorCanvas.getContext("2d");
                cCtx.clearRect(0, 0, cursorCanvas.width, cursorCanvas.height);
            };

            const drawPoint = (x, y) => {
                const ctx = maskCanvas.getContext("2d");
                ctx.lineWidth = parseInt(sizeSlider.value, 10);
                ctx.lineCap = "round";
                ctx.lineJoin = "round";

                if (currentMode === "brush") {
                    ctx.globalCompositeOperation = "source-over";
                    ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
                    ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
                } else {
                    ctx.globalCompositeOperation = "destination-out";
                }
                ctx.lineTo(x, y);
                ctx.stroke();
                ctx.beginPath();
                ctx.moveTo(x, y);
            };

            maskCanvas.addEventListener("pointerdown", (e) => {
                if (e.button !== 0) return;
                e.preventDefault();
                e.stopPropagation();
                pushHistory();
                isDrawing = true;
                const ctx = maskCanvas.getContext("2d");
                ctx.beginPath();
                const pos = getCanvasPos(e);
                drawPoint(pos.x, pos.y);
                drawCursor(pos.x, pos.y);
            });

            maskCanvas.addEventListener("pointermove", (e) => {
                const pos = getCanvasPos(e);
                drawCursor(pos.x, pos.y);
                if (!isDrawing) return;
                e.preventDefault();
                e.stopPropagation();
                drawPoint(pos.x, pos.y);
            });

            const stopDrawing = () => {
                if (!isDrawing) return;
                isDrawing = false;
                const ctx = maskCanvas.getContext("2d");
                ctx.beginPath();
                syncMaskValue();
            };

            maskCanvas.addEventListener("pointerup", stopDrawing);
            maskCanvas.addEventListener("pointerleave", () => {
                stopDrawing();
                clearCursor();
            });

            window.addEventListener("keydown", (e) => {
                if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !e.shiftKey) {
                    if (canvasWrap.matches(":hover") || node.is_selected) {
                        e.preventDefault();
                        e.stopPropagation();
                        undo();
                    }
                }
            });

            const initLayout = () => {
                this.setSize([Math.max(this.size[0], 580), Math.max(this.size[1], 620)]);
                adjustSizeAndLayout();
            };

            setTimeout(initLayout, 60);
        };
    }
});