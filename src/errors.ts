export class AppError extends Error {
 constructor(public readonly code:number,message:string,public readonly runId?:string){super(message);this.name='AppError';}
}
