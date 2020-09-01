var RLottie = (function () {
    var rlottie = {}, apiInitStarted = false, apiInited = false, initCallbacks = [];
    var deviceRatio = window.devicePixelRatio || 1;
    var rlottieWorkers = [], curWorkerNum = 0, rlottieFrames = new Map();

    var startTime = +(new Date());
    function dT() {
        return '[' + ((+(new Date()) - startTime)/ 1000.0) + '] ';
    }

    rlottie.Api = {};
    rlottie.players = Object.create(null);
    rlottie.frames = rlottieFrames;
    rlottie.WORKERS_LIMIT = 4;

    var reqId = 0;
    var mainLoopTO = false;
    var checkViewportDate = false;
    var lastRenderDate = false;

    var userAgent = window.navigator.userAgent;
    var isSafari = !!window.safari ||
        !!(userAgent && (/\b(iPad|iPhone|iPod)\b/.test(userAgent) || (!!userAgent.match('Safari') && !userAgent.match('Chrome'))));
    var isRAF = isSafari;
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
        // console.log('mainLoop');
        let rlPlayer, delta, rendered;
        const now = +Date.now();
        const checkViewport = !checkViewportDate || (now - checkViewportDate) > 1000;
        // for (let key in rlottie.players) {
        //     rlPlayer = rlottie.players[key];
        //     if (rlPlayer &&
        //         rlPlayer.frameCount) {
        //         delta = now - rlPlayer.frameThen;
        //         if (delta > rlPlayer.frameInterval) {
        //             rendered = render(rlPlayer, checkViewport, true);
        //             if (rendered) {
        //                 lastRenderDate = now;
        //             }
        //         }
        //     }
        // }

        const shiftPlayer = new Map();
        for (let key in rlottie.players) {
            shiftPlayer.set(rlottie.players[key].url, key);
        }
        for (let key in rlottie.players) {
            const rlPlayer = rlottie.players[key];
            if (rlPlayer && rlPlayer.frameCount) {
                delta = now - rlPlayer.frameThen;
                if (delta > rlPlayer.frameInterval) {
                    rendered = render(rlPlayer, checkViewport, shiftPlayer.get(rlPlayer.url) === key);
                    if (rendered) {
                        lastRenderDate = now;
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
        var isEmpty = true, key, rlPlayer;
        for (key in rlottie.players) {
            rlPlayer = rlottie.players[key];
            if (rlPlayer &&
                rlPlayer.frameCount) {
                isEmpty = false;
                break;
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
                        let rlottieWorker = rlottieWorkers[workerNum] = new QueryableWorker('tgsticker-worker.js');
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

    function destroyWorkers() {
        for (var workerNum = 0; workerNum < rlottie.WORKERS_LIMIT; workerNum++) {
            if (rlottieWorkers[workerNum]) {
                rlottieWorkers[workerNum].terminate();
                console.log('worker #' + workerNum + ' terminated');
            }
        }
        console.log('workers destroyed');
        apiInitStarted = apiInited = false;
        rlottieWorkers = [];
    }

    function initPlayer(el, options) {
        if (el.rlPlayer) return;
        if (el.tagName.toLowerCase() != 'picture') {
            console.warn('only picture tag allowed');
            return;
        }
        options = options || {};
        var rlPlayer = el.rlPlayer = {};
        rlPlayer.thumb = el.querySelector('img');
        var tgs_source = el.querySelector('source[type="application/x-tgsticker"]');
        var url = tgs_source && tgs_source.getAttribute('srcset') || '';
        if (!url) {
            console.warn('picture source application/x-tgsticker not found');
            return;
        }
        var pic_width = options.width || el.clientWidth || el.getAttribute('width');
        var pic_height = options.height || el.clientHeight || el.getAttribute('height');

        console.log('player', [pic_width, pic_height]);

        var curDeviceRatio = options.maxDeviceRatio ? Math.min(options.maxDeviceRatio, deviceRatio) : deviceRatio;
        if (!pic_width || !pic_height) {
            pic_width = pic_height = 256;
        }
        rlPlayer.url = url;
        rlPlayer.reqId = ++reqId;
        rlottie.players[reqId] = rlPlayer;
        rlPlayer.el = el;
        rlPlayer.nextFrameNo = false;
        rlPlayer.frames = {};
        rlPlayer.width = pic_width * curDeviceRatio;
        rlPlayer.height = pic_height * curDeviceRatio;
        rlPlayer.rWorker = rlottieWorkers[curWorkerNum++];
        if (curWorkerNum >= rlottieWorkers.length) {
            curWorkerNum = 0;
        }
        rlPlayer.options = options;
        // rlPlayer.times = [];
        rlPlayer.clamped = new Uint8ClampedArray(rlPlayer.width * rlPlayer.height * 4);
        rlPlayer.imageData = new ImageData(rlPlayer.width, rlPlayer.height);
        rlPlayer.rWorker.sendQuery('loadFromData', rlPlayer.reqId, url, rlPlayer.width, rlPlayer.height);

        if (!rlottieFrames.has(url)) {
            rlottieFrames.set(url, {});
        }
    }

    function destroyPlayer(el) {
        if (!el.rlPlayer) return;
        var rlPlayer = el.rlPlayer;
        delete rlottie.players[rlPlayer.reqId];
        delete rlPlayer;
        setupMainLoop();
    }

    function render(rlPlayer, checkViewport, shift) {
        const frames = rlottieFrames.get(rlPlayer.url);
        if (!rlPlayer.canvas ||
            rlPlayer.canvas.width == 0 ||
            rlPlayer.canvas.height == 0) {
            return false;
        }
        if (!rlPlayer.forceRender) {
            if (!rlPlayer.options.playWithoutFocus && !document.hasFocus() ||
                !rlPlayer.frameCount) {
                return false;
            }
            var isInViewport = rlPlayer.isInViewport;
            if (isInViewport === undefined || checkViewport) {
                var rect = rlPlayer.el.getBoundingClientRect();
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
        let frame = shift ?
            rlPlayer.frameQueue.shift() :
            (rlPlayer.frameQueue.queue.length > 0 ? rlPlayer.frameQueue.queue[0] : null);
        if (frames && frames.frameQueue) {
            frame = shift ?
                frames.frameQueue.shift() :
                (frames.frameQueue.queue.length > 0 ? frames.frameQueue.queue[0] : null);
        }
        console.log('frame', [shift, frame]);
        if (frame !== null) {
            doRender(rlPlayer, frame);
            var nextFrameNo = rlPlayer.nextFrameNo;
            if (nextFrameNo !== false) {
                rlPlayer.nextFrameNo = false;
                requestFrame(rlPlayer.reqId, nextFrameNo);
            }
        }

        return true;
    }

    function doRender(rlPlayer, frame) {
        rlPlayer.forceRender = false;
        rlPlayer.imageData.data.set(frame);
        rlPlayer.context.putImageData(rlPlayer.imageData, 0, 0);
        var now = +(new Date());
        // if (rlPlayer.frameThen) {
        //     rlPlayer.times.push(now - rlPlayer.frameThen)
        // }
        rlPlayer.frameThen = now - (now % rlPlayer.frameInterval);
        if (rlPlayer.thumb) {
            rlPlayer.el.removeChild(rlPlayer.thumb);
            delete rlPlayer.thumb;
        }
    }

    function requestFrame(reqId, frameNo) {
        var rlPlayer = rlottie.players[reqId];
        var frame = rlPlayer.frames[frameNo];
        if (frame) {
            onFrame(reqId, frameNo, frame)
        } else if (isSafari) {
            rlPlayer.rWorker.sendQuery('renderFrame', reqId, frameNo);
        } else {
            if(!rlPlayer.clamped.length) { // fix detached
                rlPlayer.clamped = new Uint8ClampedArray(rlPlayer.width * rlPlayer.height * 4);
            }
            rlPlayer.rWorker.sendQuery('renderFrame', reqId, frameNo, rlPlayer.clamped);
        }
    }

    function onFrame(reqId, frameNo, frame) {
        var rlPlayer = rlottie.players[reqId];
        if (rlPlayer.options.cachingModulo &&
            !rlPlayer.frames[frameNo] &&
            (!frameNo || ((reqId + frameNo) % rlPlayer.options.cachingModulo))) {
            rlPlayer.frames[frameNo] = new Uint8ClampedArray(frame)
        }
        rlPlayer.frameQueue.push(frame);
        const frames = rlottieFrames.get(rlPlayer.url);
        if (frames && frames.frameQueue && frames.reqId === reqId) {
            frames.frameQueue.push(frame);
        }

        var nextFrameNo = ++frameNo;
        if (nextFrameNo >= rlPlayer.frameCount) {
            nextFrameNo = 0;
            // if (rlPlayer.times.length) {
            //   var avg = 0;
            //   for (var i = 0; i < rlPlayer.times.length; i++) {
            //     avg += rlPlayer.times[i] / rlPlayer.times.length;
            //   }
            //   console.log('avg time: ' +  avg + ', ' + rlPlayer.fps);
            //   rlPlayer.times = [];
            // }
        }
        if (rlPlayer.frameQueue.needsMore() || frames && frames.frameQueue.needsMore())  {
            requestFrame(reqId, nextFrameNo)
        } else {
            rlPlayer.nextFrameNo = nextFrameNo;
        }
    }

    function onLoaded(reqId, frameCount, fps) {
        const rlPlayer = rlottie.players[reqId];
        const frames = rlottieFrames.get(rlPlayer.url);

        rlPlayer.canvas = document.createElement('canvas');
        rlPlayer.canvas.width = rlPlayer.width;
        rlPlayer.canvas.height = rlPlayer.height;
        rlPlayer.el.appendChild(rlPlayer.canvas);
        rlPlayer.context = rlPlayer.canvas.getContext('2d');

        rlPlayer.fps = fps;
        rlPlayer.frameInterval = 1000 / rlPlayer.fps;
        rlPlayer.frameThen = Date.now();
        rlPlayer.frameCount = frameCount;
        rlPlayer.forceRender = true;
        rlPlayer.frameQueue = new FrameQueue(fps / 4);
        if (frames && !frames.frameQueue) {
            frames.reqId = rlPlayer.reqId;
            frames.rWorker = rlPlayer.rWorker;
            frames.frameQueue = new FrameQueue(fps / 4);
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
