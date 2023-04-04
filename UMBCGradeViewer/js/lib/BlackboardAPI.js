// A promised based wrapper for the Blackboard Ultra Learn REST API
// https://developer.blackboard.com/portal/displayApi

(function () {
    var global = global || (() => {
        if (typeof self !== 'undefined') { return self; }
        if (typeof window !== 'undefined') { return window; }
        if (typeof globalThis !== 'undefined') { return globalThis; }
        if (typeof this !== 'undefined') { return this; }

        throw new Error('BlackboardAPI: Unable to locate global object');
    })();

    var fetch = (function () {
        if (typeof global.fetch === 'function') { return global.fetch; }
        if (typeof require === 'function') { return require('node-fetch'); }

        throw new Error('BlackboardAPI: Unable to locate fetch function');
    })();

    class BlackboardAPI {
        constructor(learningProvider, token) {
            // constructs a new instance of the BlackboardAPI class
            // where learningProvider is the name of school and
            // token is jswt

            this.learningProvider = learningProvider;
            this.token = token;
            this.uri = `https://blackboard.${this.learningProvider}.edu/learn/api/v1`;
            this.publicUri = `https://blackboard.${this.learningProvider}.edu/learn/api/public/v1`;

            this.isRefreshingToken = false;
            this.waitingForTokenRefresh = [];
            this.tokenRefresher = null;
        }

        setTokenRefresher(refresher) {
            // sets the token refresher handler
            // the refresher handler should be a function that returns a new jswt

            this.tokenRefresher = refresher;
        }

        async requestTokenRefresh() {
            // requests a new token from the token refresher handler
            if (typeof this.tokenRefresher !== 'function') {
                throw new Error('BlackboardAPI: Token refresher handler not valid');
            }

            if (this.isRefreshingToken) {
                // token is already being refreshed, wait for it to finish
                console.log('BlackboardAPI: Token is already being refreshed, waiting for it to finish...')
                return new Promise((resolve) => {
                    this.waitingForTokenRefresh.push(() => {
                        console.log('BlackboardAPI: Token has been refreshed, continuing...');
                        resolve(this.token);
                    });
                });
            }

            this.isRefreshingToken = true;

            const token = await this.tokenRefresher();
            this.token = token;

            // set a timeout to prevent spamming the token refresher
            // and avoid race conditions
            setTimeout(() => {
                this.isRefreshingToken = false;

                // flush the waiting queue
                for (const callback of this.waitingForTokenRefresh) {
                    callback();
                }

                this.waitingForTokenRefresh = [];
            }, 1000);

            return token;
        }

        async get(endpoint, urlparams = {}, attemptTokenRefresh = true) {
            // fetches the endpoint from the Blackboard API
            // and returns the response as a JSON object

            if (this.isRefreshingToken) {
                // token is being refreshed, wait for it to finish
                console.log('BlackboardAPI: Token is being refreshed, get was called, waiting...');

                return new Promise((resolve) => {
                    this.waitingForTokenRefresh.push(async () => {
                        console.log('BlackboardAPI: Get call continuing...');
                        resolve(await this.get(endpoint, urlparams, false));
                    });
                });
            }

            const options = {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${this.token}`,
                    'Content-Type': 'application/json',
                }
            };

            const url = new URL(`${this.uri}/${endpoint}`);

            for (const [key, value] of Object.entries(urlparams)) {
                url.searchParams.append(key, value);
            }

            const response = await fetch(url, options);

            if (response.status === 401) {
                if (attemptTokenRefresh) {
                    console.log('BlackboardAPI: Token has expired, attempting to refresh...');
                    // token has expired, try to refresh it
                    await this.requestTokenRefresh();

                    // try again
                    return await this.get(endpoint, urlparams, false);
                } else {
                    throw new Error('BlackboardAPI: Token has expired, please reinstate.');
                }
            } else if (response.status !== 200) {
                console.log(url.href);
                throw new Error('BlackboardApiResponseError: ' + response.statusText);
            }

            return await response.json();
        }

        async getUserData(userId) {
            // returns the user data for the given user id

            return await this.get(`users/${userId}`);
        }

        async getUserCourses(userId, activeOnly = true) {
            // returns the courses for the given user id
            // if activeOnly is true, only returns courses that are active

            let courses = await this.get(`users/${userId}/memberships`, {
                expand: 'course.effectiveAvailability,course.permissions,courseRole',
                includeCount: true,
                limit: 10000
            });

            // map the courses to only include the course data
            courses = courses.results.map(({ course }) => course);

            if (activeOnly) {
                return courses.filter(course =>
                    course.isAvailable && // course is available
                    !course.isClosed &&      // course has not been closed
                    new Date(course.endDate) > new Date() // course has not ended
                );
            }

            return courses;
        }

        async getCourseAssignments(userId, courseId) {
            // returns a list of grade objects
            // for the given user and course

            const assignment = await this.get(`courses/${courseId}/gradebook/grades`, {
                userId: userId,
                limit: 1000
            });

            return assignment.results;
        }

        async getCourseAssignmentName(assignment) {
            // returns the name of the assignment
            // for the given assignment

            const columnId = assignment.columnId;
            const courseId = assignment.courseId;

            const column = await this.get(`courses/${courseId}/gradebook/columns/${columnId}`);

            return column.columnName;
        }

        determineGrade(assignment) {
            // calculates the percentage grade
            // for the given assignment

            const status = assignment.status;
            const displayGrade = assignment.displayGrade;

            if (status !== 'GRADED' || !displayGrade) {
                // assignment has not been graded yet
                return null;
            }

            const earned = displayGrade.score;
            const possible = assignment.pointsPossible;
            const grade = (earned / Math.max(1, possible)) * 100;

            return {
                earnedPoints: earned,
                possiblePoints: possible,
                grade: grade,
                gradeFormatted: `${earned}/${possible} (${grade.toFixed(2)}%)`
            };
        }
    }

    // export the BlackboardAPI class
    Object.defineProperty(global, 'BlackboardAPI', {
        value: BlackboardAPI,
        writable: false,
        enumerable: false,
        configurable: false
    });

    if (typeof module !== 'undefined') module.exports = BlackboardAPI;

    return BlackboardAPI;
})();