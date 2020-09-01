const RLottie = (function () {
    let rlottie = {}, apiInitStarted = false, apiInited = false, initCallbacks = [];
    let deviceRatio = window.devicePixelRatio || 1;
    let rlottieWorkers = [], curWorkerNum = 0, rlottieFrames = new Map();

    let startTime = +(new Date());
    function dT() {
        return '[' + ((+(new Date()) - startTime)/ 1000.0) + '] ';
    }

    rlottie.Api = {};
    rlottie.players = Object.create(null);
    rlottie.frames = rlottieFrames;
    rlottie.WORKERS_LIMIT = 4;

    let reqId = 0;
    let mainLoopTO = false;
    let checkViewportDate = false;
    let lastRenderDate = false;

    let { userAgent } = window.navigator;
    let isSafari = !!window.safari ||
        !!(userAgent && (/\b(iPad|iPhone|iPod)\b/.test(userAgent) || (!!userAgent.match('Safari') && !userAgent.match('Chrome'))));
    let isRAF = isSafari;
    rlottie.isSafari = isSafari;

    function wasmIsSupported() {
        try {
            if (typeof WebAssembly === 'object' &&
                typeof WebAssembly.instantiate === 'function') {
                const module = new WebAssembly.Module(Uint8Array.of(
                    0x0, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00
                ));
                if (module instanceof WebAssembly.Module) {
                    return new WebAssembly.Instance(module) instanceof WebAssembly.Instance;
                }
            }
        } catch (e) {}
        return false;
    }

    function isSupported() {
        return (
            wasmIsSupported() &&
            typeof Uint8ClampedArray !== 'undefined' &&
            typeof Worker !== 'undefined' &&
            typeof ImageData !== 'undefined'
        );
    }

    rlottie.isSupported = isSupported();

    function mainLoop() {
        let delta, rendered;
        const now = +Date.now();
        const checkViewport = !checkViewportDate || (now - checkViewportDate) > 1000;

        const shiftPlayer = new Map();
        for (let key in rlottie.players) {
            shiftPlayer.set(rlottie.players[key].url, key);
        }
        for (let key in rlottie.players) {
            const rlPlayer = rlottie.players[key];
            if (rlPlayer) {
                const data = rlottieFrames.get(rlPlayer.url);
                if (data && data.frameCount) {
                    delta = now - data.frameThen;
                    if (delta > data.frameInterval) {
                        rendered = render(rlPlayer, checkViewport, shiftPlayer.get(rlPlayer.url) === key);
                        if (rendered) {
                            lastRenderDate = now;
                        }
                    }
                }
            }
        }

        const delay = now - lastRenderDate < 100 ? 16 : 500;
        if (delay < 20 && isRAF) {
            mainLoopTO = requestAnimationFrame(mainLoop)
        } else {
            mainLoopTO = setTimeout(mainLoop, delay);
        }
        if (checkViewport) {
            checkViewportDate = now;
        }
    }

    function setupMainLoop() {
        let isEmpty = true;
        for (const key in rlottie.players) {
            const rlPlayer = rlottie.players[key];
            if (rlPlayer) {
                const data = rlottieFrames.get(rlPlayer.url);
                if (data && data.frameCount) {
                    isEmpty = false;
                    break;
                }
            }
        }
        if ((mainLoopTO !== false) === isEmpty) {
            if (isEmpty) {
                if (isRAF) {
                    cancelAnimationFrame(mainLoopTO);
                }
                try {
                    clearTimeout(mainLoopTO);
                } catch (e) {};
                mainLoopTO = false;
            } else {
                if (isRAF) {
                    mainLoopTO = requestAnimationFrame(mainLoop);
                } else {
                    mainLoopTO = setTimeout(mainLoop, 0);
                }
            }
        }
    }

    function initApi(callback) {
        if (apiInited) {
            callback && callback();
        } else {
            callback && initCallbacks.push(callback);
            if (!apiInitStarted) {
                apiInitStarted = true;
                let workersRemain = rlottie.WORKERS_LIMIT;
                for (let workerNum = 0; workerNum < rlottie.WORKERS_LIMIT; workerNum++) {
                    (function(workerNum) {
                        const rlottieWorker = rlottieWorkers[workerNum] = new QueryableWorker('rlottie-wasm/rlottie-wasm.worker.js');
                        rlottieWorker.addListener('ready', function () {
                            console.log(dT(), 'worker #' + workerNum + ' ready');
                            rlottieWorker.addListener('frame', onFrame);
                            rlottieWorker.addListener('loaded', onLoaded);
                            --workersRemain;
                            if (!workersRemain) {
                                console.log(dT(), 'workers ready');
                                apiInited = true;
                                for (let i = 0; i < initCallbacks.length; i++) {
                                    initCallbacks[i]();
                                }
                                initCallbacks = [];
                            }
                        });
                    })(workerNum);
                }
            }
        }
    }

    function initPlayer(el, options) {
        if (el.rlPlayer) return;
        if (el.tagName.toLowerCase() != 'picture') {
            console.warn('only picture tag allowed');
            return;
        }

        options = options || {};
        const rlPlayer = el.rlPlayer = {};
        rlPlayer.thumb = el.querySelector('img');
        const tgs_source = el.querySelector('source[type="application/x-tgsticker"]');
        const url = tgs_source && tgs_source.getAttribute('srcset') || '';
        if (!url) {
            console.warn('picture source application/x-tgsticker not found');
            return;
        }
        let pic_width = options.width || el.clientWidth || el.getAttribute('width');
        let pic_height = options.height || el.clientHeight || el.getAttribute('height');

        console.log('player', [pic_width, pic_height]);

        const curDeviceRatio = options.maxDeviceRatio ? Math.min(options.maxDeviceRatio, deviceRatio) : deviceRatio;
        if (!pic_width || !pic_height) {
            pic_width = pic_height = 256;
        }
        rlPlayer.url = url;
        rlPlayer.reqId = ++reqId;
        rlottie.players[reqId] = rlPlayer;
        rlPlayer.el = el;
        rlPlayer.width = pic_width * curDeviceRatio;
        rlPlayer.height = pic_height * curDeviceRatio;
        rlPlayer.options = options;
        rlPlayer.clamped = new Uint8ClampedArray(rlPlayer.width * rlPlayer.height * 4);
        rlPlayer.imageData = new ImageData(rlPlayer.width, rlPlayer.height);

        rlPlayer.canvas = document.createElement('canvas');
        rlPlayer.canvas.width = pic_width * curDeviceRatio;
        rlPlayer.canvas.height = pic_height * curDeviceRatio;
        rlPlayer.el.appendChild(rlPlayer.canvas);
        rlPlayer.context = rlPlayer.canvas.getContext('2d');
        rlPlayer.forceRender = true;

        if (!rlottieFrames.has(url)) {
            const rWorker = rlottieWorkers[curWorkerNum++];
            if (curWorkerNum >= rlottieWorkers.length) {
                curWorkerNum = 0;
            }

            rlottieFrames.set(url, {
                reqId: rlPlayer.reqId,
                nextFrameNo: false,
                rWorker,
                frames: {}
            });

            rWorker.sendQuery('loadFromData', rlPlayer.reqId, url, rlPlayer.width, rlPlayer.height);
        }
    }

    function destroyWorkers() {
        for (let workerNum = 0; workerNum < rlottie.WORKERS_LIMIT; workerNum++) {
            if (rlottieWorkers[workerNum]) {
                rlottieWorkers[workerNum].terminate();
                console.log('worker #' + workerNum + ' terminated');
            }
        }
        console.log('workers destroyed');
        apiInitStarted = apiInited = false;
        rlottieWorkers = [];
    }

    function destroyPlayer(el) {
        if (!el.rlPlayer) return;

        delete rlottie.players[el.rlPlayer.reqId];

        setupMainLoop();
    }

    function render(rlPlayer, checkViewport, shift) {
        const data = rlottieFrames.get(rlPlayer.url);
        if (!rlPlayer.canvas || rlPlayer.canvas.width == 0 || rlPlayer.canvas.height == 0) {
            return false;
        }

        if (!rlPlayer.forceRender) {
            if (!rlPlayer.options.playWithoutFocus && !document.hasFocus() || !data.frameCount) {
                return false;
            }
            let isInViewport = rlPlayer.isInViewport;
            if (isInViewport === undefined || checkViewport) {
                const rect = rlPlayer.el.getBoundingClientRect();
                if (rect.bottom < 0 ||
                    rect.right < 0 ||
                    rect.top > (window.innerHeight || document.documentElement.clientHeight) ||
                    rect.left > (window.innerWidth || document.documentElement.clientWidth)) {
                    isInViewport = false;
                } else {
                    isInViewport = true;
                }
                rlPlayer.isInViewport = isInViewport;
            }
            if (!isInViewport) {
                return false;
            }
        }

        const frame = shift ?
            data.frameQueue.shift() :
            (data.frameQueue.queue.length > 0 ? data.frameQueue.queue[0] : null);

        if (frame !== null) {
            doRender(rlPlayer, frame);

            if (shift) {
                const now = +(new Date());
                data.frameThen = now - (now % data.frameInterval);

                const nextFrameNo = data.nextFrameNo;
                if (nextFrameNo !== false) {
                    data.nextFrameNo = false;
                    requestFrame(data.reqId, nextFrameNo);
                }
            }
        }

        return true;
    }

    function doRender(rlPlayer, frame) {
        rlPlayer.forceRender = false;
        rlPlayer.imageData.data.set(frame);
        rlPlayer.context.putImageData(rlPlayer.imageData, 0, 0);

        if (rlPlayer.thumb) {
            rlPlayer.el.removeChild(rlPlayer.thumb);
            delete rlPlayer.thumb;
        }
    }

    function requestFrame(reqId, frameNo) {
        const rlPlayer = rlottie.players[reqId];
        const data = rlottieFrames.get(rlPlayer.url);

        const frame = data.frames[frameNo];
        if (frame) {
            onFrame(reqId, frameNo, frame)
        } else if (isSafari) {
            if (data.reqId === reqId) data.rWorker.sendQuery('renderFrame', reqId, frameNo);
        } else {
            if(!rlPlayer.clamped.length) { // fix detached
                rlPlayer.clamped = new Uint8ClampedArray(rlPlayer.width * rlPlayer.height * 4);
            }
            if (data.reqId === reqId) data.rWorker.sendQuery('renderFrame', reqId, frameNo, rlPlayer.clamped);
        }
    }

    function onFrame(reqId, frameNo, frame) {
        const rlPlayer = rlottie.players[reqId];
        const data = rlottieFrames.get(rlPlayer.url);

        if (rlPlayer.options.cachingModulo &&
            !data.frames[frameNo] &&
            (!frameNo || ((reqId + frameNo) % rlPlayer.options.cachingModulo))) {
            data.frames[frameNo] = new Uint8ClampedArray(frame)
        }
        if (data && data.reqId === reqId) {
            data.frameQueue.push(frame);
        }

        let nextFrameNo = ++frameNo;
        if (nextFrameNo >= data.frameCount) {
            nextFrameNo = 0;
        }
        if (data.frameQueue.needsMore())  {
            requestFrame(reqId, nextFrameNo)
        } else {
            data.nextFrameNo = nextFrameNo;
        }
    }

    function onLoaded(reqId, frameCount, fps) {
        const rlPlayer = rlottie.players[reqId];
        const data = rlottieFrames.get(rlPlayer.url);

        if (data && !data.frameQueue) {
            data.fps = fps;
            data.frameThen = Date.now();
            data.frameInterval = 1000 / fps;
            data.frameCount = frameCount;
            data.frameQueue = new FrameQueue(fps / 4);
        }

        setupMainLoop();
        requestFrame(reqId, 0);
    }

    rlottie.init = function(el, options) {
        if (!rlottie.isSupported) {
            return false;
        }
        initApi(function() {
            initPlayer(el, options);
        });
    }

    rlottie.destroy = function(el) {
        destroyPlayer(el);
    }

    rlottie.destroyWorkers = function() {
        destroyWorkers();
    }

    return rlottie;
}());

class QueryableWorker {
    constructor(url, defaultListener, onError) {
        this.worker = new Worker(url);
        this.listeners = [];

        this.defaultListener = defaultListener || function() { };
        if (onError) {
            this.worker.onerror = onError;
        }

        this.worker.onmessage = event => {
            if (event.data instanceof Object &&
                event.data.hasOwnProperty('queryMethodListener') &&
                event.data.hasOwnProperty('queryMethodArguments')) {
                this.listeners[event.data.queryMethodListener].apply(this, event.data.queryMethodArguments);
            } else {
                this.defaultListener.call(this, event.data);
            }
        };
    }

    postMessage(message) {
        this.worker.postMessage(message);
    }

    terminate() {
        this.worker.terminate();
    }

    addListener(name, listener) {
        this.listeners[name] = listener;
    }

    removeListener(name) {
        delete this.listeners[name];
    }

    /*
      This functions takes at least one argument, the method name we want to query.
      Then we can pass in the arguments that the method needs.
    */
    sendQuery(queryMethod) {
        if (arguments.length < 1) {
            throw new TypeError('QueryableWorker.sendQuery takes at least one argument');
            return;
        }
        queryMethod = arguments[0];
        const args = Array.prototype.slice.call(arguments, 1);
        if (RLottie.isSafari) {
            this.worker.postMessage({
                'queryMethod': queryMethod,
                'queryMethodArguments': args
            });
        } else {
            const transfer = [];
            for(var i = 0; i < args.length; i++) {
                if(args[i] instanceof ArrayBuffer) {
                    transfer.push(args[i]);
                }

                if(args[i].buffer && args[i].buffer instanceof ArrayBuffer) {
                    transfer.push(args[i].buffer);
                }
            }

            this.worker.postMessage({
                'queryMethod': queryMethod,
                'queryMethodArguments': args
            }, transfer);
        }
    }
}

class FrameQueue {
    constructor(maxLength) {
        this.queue = [];
        this.maxLength = maxLength;
    }

    needsMore() {
        return this.queue.length < this.maxLength;
    }

    empty() {
        return !this.queue.length;
    }

    push(element) {
        return this.queue.push(element);
    }

    shift() {
        return this.queue.length ? this.queue.shift() : null;
    }
}
