function injectScript(location, delay = 0) {
    // inserts a js script into the DOM with an optional delay
    // and resolves only if it loads successfully

    return new Promise((resolve, reject) => {
        setTimeout(function () {
            var script = document.createElement('script');

            script.src = chrome.runtime.getURL(location);

            (document.head || document.documentElement).appendChild(script);

            script.onload = function () {
                script.parentNode.removeChild(script);
                resolve();
            };

            script.onerror = function () {
                script.parentNode.removeChild(script);
                reject();
            };
        }, delay);
    });
}

(function () {
    // inject the BlackboardAPI and LMSBridge scripts
    // then finally insert main script once both are globally available

    Promise.all([injectScript('/js/lib/BlackboardAPI.js'), injectScript('/js/lib/LMSBridge.js')]).then(() => {
        injectScript('/js/main.js');
    });
})();