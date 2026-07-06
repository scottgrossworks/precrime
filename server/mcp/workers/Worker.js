// Worker.js -- abstract base for a unit-of-work executor.
//
// A Worker processes ONE already-claimed Task. Two subclasses exist:
//   - the LLM/goose path stays in the conductor (spawns goose.exe on a skill .md);
//   - ProceduralWorker (this hierarchy) runs pure JS in-process, no model, no goose.
// The conductor claims/completes the Task; a Worker's run() only does the work and
// returns { status, output, summary, error } for the caller to complete with.

class Worker {
    // task: the claimed Task row. deps: injected collaborators (e.g. { pipelineSave }).
    constructor(task, deps) {
        this.task = task;
        this.deps = deps || {};
    }

    async run() {
        throw new Error('Worker.run is abstract -- subclass must implement it');
    }
}

module.exports = { Worker };
