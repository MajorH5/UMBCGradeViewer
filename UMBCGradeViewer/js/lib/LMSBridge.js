// class that handles communication with the LMS and rendering it to the DOM
(function () {
    const HTML = {
        gradePill: `
    <div class="columns small-4 current-grade overall-grade-ftue-target">
        <a class="no-underline" href="#" title="Overall Grade">
            <div class="grade-color">
              <div class="wrapping-input-style readonly pill-style green">
                  <span class="grade-input-display grade-ellipsis">
                    <bdi>Loading...</bdi>
                  </span>
              </div>
            </div>
        </a>
    </div>`
    };

    const CSS_GRADE_CLASSES = {
        NA: 'na',
        A: 'green',
        B: 'yellowgreen',
        C: 'yellow',
        D: 'orange',
        F: 'red'
    };

    var global = global || (() => {
        if (typeof self !== 'undefined') { return self; }
        if (typeof window !== 'undefined') { return window; }
        if (typeof globalThis !== 'undefined') { return globalThis; }
        if (typeof this !== 'undefined') { return this; }

        throw new Error('LMSBridge: Unable to locate global object');
    })();

    var fetch = (function () {
        if (typeof global.fetch === 'function') { return global.fetch; }
        if (typeof require === 'function') { return require('node-fetch'); }

        throw new Error('LMSBridge: Unable to locate fetch function');
    })();

    class LMSBridge {
        constructor(lms) {
            // creates a new instance of the LMSBridge class

            if (typeof lms !== 'string') {
                throw new TypeError('LMSBridge: lms must be a string');
            }

            this.lms = lms;
            this.integrationWindow = null;
            this.token = null;
            this.userObject = null;
            this.api = null;
            this.initialized = false;
            this.courseCards = {};
        }

        async initialize() {
            // initialize the LMSBridge so it's ready to
            // interact with the DOM

            if (this.initialized) { return; }

            this.initialized = true;

            this.integrationWindow = await this.getIntegrationWindow();
            this.token = await this.getToken();
            this.userObject = await this.getUserObject();
            this.api = new BlackboardAPI(this.lms, this.token);
            this.refreshCourseCards();

            this.api.setTokenRefresher(async () => {
                this.token = await this.getToken();
                console.log('LMSBridge: Token refreshed!');
                return this.token;
            });
        }

        async getIntegrationWindow() {
            console.log('[1/3] LMSBridge: Waiting for integration window.');

            // need to access the token from the integration iframe in a secure way
            // to streamline the authentication process and avoid repetitive user authorization.
            return new Promise((resolve) => {
                let integrationiFrame = document.querySelector('iframe#_319_1');

                let loadInterval = setInterval(() => {
                    if (integrationiFrame) {
                        integrationiFrame.addEventListener('load', function () {
                            // integration script should have loaded by now
                            // safe to resolve
                            clearInterval(loadInterval);
                            resolve(integrationiFrame.contentWindow);
                        });
                    } else {
                        // integration iframe doesn't exist yet
                        integrationiFrame = document.querySelector('iframe#_319_1');
                    }
                }, 10);
            });
        }

        async getToken() {
            console.log('[2/3] LMSBridge: Waiting for token from integration iframe.');

            // send a message to the integration iframe to request the token
            const integrationMessageChannel = new MessageChannel();
            const integrationMessagePort = integrationMessageChannel.port1;

            const promise = new Promise((resolve) => {
                integrationMessagePort.onmessage = (event) => {
                    if (event.data.type === 'authorization:authorize') {
                        resolve(event.data.token);
                    }
                }
            });

            const message = {
                type: 'integration:hello'
            };

            this.integrationWindow.postMessage(message, '*', [integrationMessageChannel.port2]);

            return promise;
        }

        async getUserObject() {
            console.log('[3/3] LMSBridge: Fetching/running initial context.');

            // fetch the user object be re-running the initial context script,
            // since it's not available in the chrome extension's context

            const blackboardHTML = document.createElement('html');
            const innerContent = await fetch('https://blackboard.umbc.edu/ultra/course/').then(e => e.text());

            blackboardHTML.innerHTML = innerContent;

            const contextScriptCode = blackboardHTML.querySelector('#initial-context-script').innerHTML;

            try {
                // errors due to the script no longer
                // being executed in a DOM element
                eval(contextScriptCode);
            } catch (e) { };

            return window.__initialContext.user;
        }

        async updateGradePill(id, courseId) {
            // updates the appended grade pill for a course
            // with our calculated grade    
            const courseCard = await this.getCourseCard(courseId);

            if (courseCard === null) {
                throw new Error(`LMSBridge: Course card not found for ${courseId}.`);
            }

            const [courseGrade, earned, possible] = await this.calculateGradeForCourse(id);

            const gradePill = courseCard.gradePill;
            const gradeElem = gradePill.querySelector('.pill-style');

            gradeElem.classList.remove(CSS_GRADE_CLASSES.NA);

            if (courseGrade >= 0.9) {
                gradeElem.classList.add(CSS_GRADE_CLASSES.A);
            } else if (courseGrade >= 0.8) {
                gradeElem.classList.add(CSS_GRADE_CLASSES.B);
            } else if (courseGrade >= 0.7) {
                gradeElem.classList.add(CSS_GRADE_CLASSES.C);
            } else if (courseGrade >= 0.6) {
                gradeElem.classList.add(CSS_GRADE_CLASSES.D);
            } else {
                gradeElem.classList.add(CSS_GRADE_CLASSES.F);
            }

            const gradeTextElem = gradeElem.querySelector('bdi')
            gradeTextElem.innerText = `${Math.floor(courseGrade * 100)}% (${earned}/${possible})`;
        }

        async calculateGradeForCourse(id) {
            // creates an unweighted grade for a course
            // by compiling the grades of all assignments into a single grade
            const assignments = await this.api.getCourseAssignments(this.userObject.id, id);

            let earned = 0;
            let possible = 0;

            for (const assignment of assignments) {
                const assignmentGrade = this.api.determineGrade(assignment);

                if (assignmentGrade !== null) {
                    // perform null check due to some assignments
                    // not having grades yet
                    earned += assignmentGrade.earnedPoints;
                    possible += assignmentGrade.possiblePoints;
                }
            }

            return [earned / Math.max(1, possible), Math.floor(earned), Math.floor(possible)];
        }

        async getCourseCard(courseId, maxRetry = 5) {
            // returns the grade card for a course
            // if it exists
            if (courseId in this.courseCards) {
                return this.courseCards[courseId];
            } else {
                // refresh the course cards and try again
                if (maxRetry > 0) {
                    this.refreshCourseCards();

                    return new Promise((resolve) => {
                        setTimeout(async () => {
                            resolve(await this.getCourseCard(courseId, maxRetry - 1));
                        }, 1000);
                    });
                }

                // give up
                return null;
            }
        }

        refreshCourseCards() {
            // refreshes the course cards object
            this.courseCards = {};

            const cards = this.getCourseCards();

            for (const card of cards) {
                this.courseCards[card.courseId] = card;
            }

            return this.courseCards;
        }

        getCourseCards() {
            // returns an array of grade cards
            // parsed into logical objects
            const cards = document.querySelectorAll('bb-base-grades-student');

            return Array.from(cards).map((card) => {
                const courseTitleElem = card.querySelector('.columns.small-8.child-is-invokable');

                if (courseTitleElem === null) { return null; }

                // ensure this is visible on DOM
                let element = courseTitleElem;
                while (element.parentNode) {
                    if (element.parentNode === document) {
                        break;
                    }

                    if (element.parentNode.style.display === 'none') {
                        return null;
                    }

                    element = element.parentNode;
                }

                let courseTitleClone = courseTitleElem.parentNode.querySelector('.course-title-clone')

                if (courseTitleClone === null) {
                    // our title clone doesn't exist yet
                    // create it
                    courseTitleClone = courseTitleElem.cloneNode(true);
                    courseTitleClone.classList.add('course-title-clone');

                    let subHeader = courseTitleClone.querySelector('.subheader').querySelector('a');
                    let header = courseTitleClone.querySelector('.course-number');

                    header.innerText = 'UMBC - GRADE VIEWER';
                    subHeader.innerText = 'Estimated Unweighted Grade:';
                    subHeader.href = '#';

                    courseTitleElem.parentNode.appendChild(courseTitleClone);
                }

                let gradeDisplayElem = courseTitleElem.parentNode.querySelector('.grade-display');

                if (gradeDisplayElem === null) {
                    // grade pill doesn't exist yet
                    // create it
                    gradeDisplayElem = document.createElement('div');
                    gradeDisplayElem.classList.add('grade-display');
                    gradeDisplayElem.innerHTML = HTML.gradePill;
                    courseTitleElem.parentNode.appendChild(gradeDisplayElem);
                }

                let courseId = courseTitleElem.querySelector('.course-number').innerText;
                let courseName = courseTitleElem.querySelector('.subheader').querySelector('a').innerText;

                return {
                    courseName: courseName,
                    courseId: courseId,
                    gradePill: gradeDisplayElem,
                    card: card
                };
            }).filter(e => e !== null);
        }
    }

    // export the LMSBridge class
    Object.defineProperty(global, 'LMSBridge', {
        value: LMSBridge,
        writable: false,
        enumerable: false,
        configurable: false
    });

    if (typeof module !== 'undefined') module.exports = LMSBridge;

    return LMSBridge;
})();