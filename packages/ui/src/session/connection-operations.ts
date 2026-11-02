// What a connection request does, in words: the connections service labels each request with the same words
// (`details.connection.request.operation`, #464, #465), and the transcript reads them from here for calls that carry
// none, such as those made before the service did.
export * from "@kantel/contracts/connection-operations";
