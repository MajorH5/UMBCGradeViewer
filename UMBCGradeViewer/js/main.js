(function () {
    const GRADES_URL = 'https://blackboard.umbc.edu/ultra/grades'

    const lms = new LMSBridge('umbc');

    console.log(lms);

    const refreshCourses = async () => {
        const courses = await lms.api.getUserCourses(lms.userObject.id, true);

        for (const course of courses) {
            lms.updateGradePill(course.id, course.courseId);
        }
    };

    lms.initialize().then(async () => {
        console.log('main.js: LMSBridge initialized.');

        let previousUrl = window.location.href;

        if (previousUrl === GRADES_URL) {
            try { await refreshCourses(); } catch (e) {
                // refresh on next poll if there was an error
                previousUrl = null;
            }
        }

        // no realistic access to routing change events in Blackboard from this context,
        // so we have to poll for changes in the URL
        setInterval(async () => {
            let currentUrl = window.location.href;

            let wasChange = currentUrl !== previousUrl;
            let isOnGrades = currentUrl === GRADES_URL;

            if (wasChange && isOnGrades) {
                lms.refreshCourseCards();

                try { await refreshCourses(); } catch (e) {
                    console.log('main.js: There was an error refreshing the course(s). Cards do not exist yet?');
                    console.error(e);
                }
            }

            previousUrl = currentUrl;
        }, 50);
    });
})();