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

            const canvasWrap = document.createElement("div");
            Object.assign(canvasWrap.style, {
                position: "relative",
                width: "100%",
                height: "260px",
                backgroundColor: "#111116",
                borderRadius: "4px",
                overflow: "hidden",
                border: "1px solid #333342"
            });

            const bgCanvas = document.createElement("canvas");
            const maskCanvas = document.createElement("canvas");

            [bgCanvas, maskCanvas].forEach((c) => {
                Object.assign(c.style, {
                    position: "absolute",
                    left: "0",
                    top: "0",
                    width: "100%",
                    height: "100%",
                    objectFit: "contain"
                });
                canvasWrap.appendChild(c);
            });

            container.appendChild(toolbar);
            container.appendChild(canvasWrap);

            const domWidget = this.addDOMWidget("canvas_ui", "customcanvas", container, {
                getValue: () => (maskWidget ? maskWidget.value : ""),
                setValue: (v) => {}
            });
            domWidget.computeSize = (width) => [width, 300];

            let isDrawing = false;
            let currentMode = "brush";
            let currentImg = null;

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
                const ctx = maskCanvas.getContext("2d");
                ctx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
                syncMaskValue();
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
            };

            const redrawBg = () => {
                if (!currentImg) return;
                resizeCanvases(currentImg.naturalWidth, currentImg.naturalHeight);
                const bgCtx = bgCanvas.getContext("2d");
                bgCtx.clearRect(0, 0, bgCanvas.width, bgCanvas.height);
                bgCtx.drawImage(currentImg, 0, 0, bgCanvas.width, bgCanvas.height);
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

            const loadImage = (filename) => {
                if (!filename) return;
                const img = new Image();
                img.onload = () => {
                    currentImg = img;
                    redrawBg();
                    if (maskWidget && maskWidget.value) {
                        loadMaskFromData(maskWidget.value);
                    }
                };
                img.src = api.apiURL(`/view?filename=${encodeURIComponent(filename)}&type=input`);
            };

            if (imgWidget) {
                const origCb = imgWidget.callback;
                imgWidget.callback = function (v) {
                    if (origCb) origCb.apply(this, arguments);
                    loadImage(v);
                };
                if (imgWidget.value) {
                    loadImage(imgWidget.value);
                }
            }

            const getCanvasPos = (e) => {
                const rect = maskCanvas.getBoundingClientRect();
                const scaleX = maskCanvas.width / rect.width;
                const scaleY = maskCanvas.height / rect.height;
                return {
                    x: (e.clientX - rect.left) * scaleX,
                    y: (e.clientY - rect.top) * scaleY
                };
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
                isDrawing = true;
                const ctx = maskCanvas.getContext("2d");
                ctx.beginPath();
                const pos = getCanvasPos(e);
                drawPoint(pos.x, pos.y);
            });

            maskCanvas.addEventListener("pointermove", (e) => {
                if (!isDrawing) return;
                e.preventDefault();
                e.stopPropagation();
                const pos = getCanvasPos(e);
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
            maskCanvas.addEventListener("pointerleave", stopDrawing);

            const adjustSize = () => {
                this.setSize([Math.max(this.size[0], 360), Math.max(this.size[1], 440)]);
            };

            setTimeout(adjustSize, 50);
        };
    }
});