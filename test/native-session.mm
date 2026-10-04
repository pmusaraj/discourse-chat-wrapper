#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>
#include <string>
#include <cassert>
using webview_t = void *;
static std::string g_html_path;
static void load_html_file(webview_t, const std::string &) {}
static const int WEBVIEW_NATIVE_HANDLE_KIND_BROWSER_CONTROLLER = 1;
static void *webview_get_native_handle(webview_t, int) { return nullptr; }
static NSString *ns(const std::string &s) { return [NSString stringWithUTF8String:s.c_str()]; }
static std::string json_escape(const char *s) { return std::string("\"") + s + "\""; }
static void sock_write_line(const std::string &) {}
#include "../native/chat-session.inc"

@interface TestCookieStore : NSObject
@property(retain) NSArray *initial;
@property(retain) NSMutableArray *saved;
@property(retain) NSMutableArray *deleted;
@end
@implementation TestCookieStore
- (void)getAllCookies:(void (^)(NSArray *))completion { completion(self.initial); }
- (void)deleteCookie:(NSHTTPCookie *)cookie completionHandler:(void (^)(void))completion { [self.deleted addObject:cookie]; completion(); }
- (void)setCookie:(NSHTTPCookie *)cookie completionHandler:(void (^)(void))completion { [self.saved addObject:cookie]; completion(); }
@end

@interface TestSession : ChatSessionRequest
@property(copy) NSString *outcome;
@property(copy) NSString *scenario;
@property(retain) NSMutableArray *paths;
@end
@implementation TestSession
- (void)finish:(NSString *)status {
  self.outcome = status;
  [self.session invalidateAndCancel];
  self.session = nil;
}
- (void)request:(NSString *)path method:(NSString *)method csrf:(NSString *)csrf
 completion:(void (^)(NSData *, NSHTTPURLResponse *, NSError *))completion {
  [self.paths addObject:path];
  NSURL *url = [NSURL URLWithString:[self.origin stringByAppendingString:path]];
  NSInteger code = 200;
  NSDictionary *body = @{};
  NSDictionary *headers = @{};
  // Only the selected site's cookies enter the native network session.
  for (NSHTTPCookie *cookie in self.session.configuration.HTTPCookieStorage.cookies) assert(![cookie.domain containsString:@"unrelated"]);
  if ([method isEqualToString:@"DELETE"]) {
    assert([path isEqualToString:@"/session/current.json"]);
    assert([csrf isEqualToString:@"csrf-token"]);
    code = [self.scenario isEqualToString:@"logout-failed"] ? 500 : 200;
    body = @{@"redirect_url": @"/"};
  } else if ([path isEqualToString:@"/session/csrf.json"]) {
    assert([method isEqualToString:@"GET"]);
    body = [self.scenario isEqualToString:@"bad-csrf"] ? @{} : @{@"csrf": @"csrf-token"};
  } else if ([path hasPrefix:@"/session/otp/"]) {
    assert([method isEqualToString:@"POST"]);
    assert([csrf isEqualToString:@"csrf-token"]);
    code = 302;
    headers = @{@"Location": [self.scenario isEqualToString:@"redirect"] ? @"https://unrelated.test/" : @"https://community.test/"};
    if ([self.scenario isEqualToString:@"missing-redirect"]) headers = @{};
    NSHTTPCookie *cookie = [NSHTTPCookie cookieWithProperties:@{ NSHTTPCookieDomain: @"community.test", NSHTTPCookiePath: @"/", NSHTTPCookieName: @"_t", NSHTTPCookieValue: @"new-session", NSHTTPCookieSecure: @"TRUE" }];
    [self.session.configuration.HTTPCookieStorage setCookie:cookie];
  } else {
    assert([path isEqualToString:@"/session/current.json"]);
    code = [@[@"expired", @"logout-expired"] containsObject:self.scenario] ? 403 : 200;
    if ([@[@"expired-404", @"logout-expired-404"] containsObject:self.scenario]) code = 404;
    body = [self.scenario isEqualToString:@"invalid-json"] ? @{} : @{@"current_user": @{@"id": @42}};
  }
  NSHTTPURLResponse *response = [[[NSHTTPURLResponse alloc] initWithURL:url statusCode:code HTTPVersion:@"HTTP/1.1" headerFields:headers] autorelease];
  completion([NSJSONSerialization dataWithJSONObject:body options:0 error:nil], response, nil);
}
@end

int main() {
  @autoreleasepool {
    for (NSString *scenario in @[@"active", @"expired", @"expired-404", @"logout-expired-404", @"invalid-json", @"login", @"bad-csrf", @"redirect", @"missing-redirect", @"logout", @"logout-expired", @"logout-failed"]) {
      TestSession *request = [[TestSession alloc] init];
      TestCookieStore *store = [[TestCookieStore alloc] init];
      store.initial = @[[NSHTTPCookie cookieWithProperties:@{ NSHTTPCookieDomain: @"unrelated.test", NSHTTPCookiePath: @"/", NSHTTPCookieName: @"secret", NSHTTPCookieValue: @"unrelated" }]];
      store.initial = [store.initial arrayByAddingObject:[NSHTTPCookie cookieWithProperties:@{ NSHTTPCookieDomain: @"community.test", NSHTTPCookiePath: @"/", NSHTTPCookieName: @"_t", NSHTTPCookieValue: @"existing-session" }]];
      store.saved = [NSMutableArray array];
      store.deleted = [NSMutableArray array];
      request.operation = [scenario hasPrefix:@"logout"] ? @"logout" : @"check";
      request.store = (WKHTTPCookieStore *)store;
      request.origin = @"https://community.test";
      request.scenario = scenario;
      request.paths = [NSMutableArray array];
      request.token = [@[@"login", @"bad-csrf", @"redirect", @"missing-redirect"] containsObject:scenario] ? @"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" : @"";
      [request start];
      NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:5];
      while (!request.outcome && [deadline timeIntervalSinceNow] > 0) [[NSRunLoop mainRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:.01]];
      NSString *expected = [@[@"active", @"login"] containsObject:scenario] ? @"active" : [@[@"expired", @"expired-404", @"redirect", @"missing-redirect"] containsObject:scenario] ? @"expired" : @"unavailable";
      if ([@[@"logout", @"logout-expired", @"logout-expired-404"] containsObject:scenario]) expected = @"logged-out";
      assert([request.outcome isEqualToString:expected]);
      if ([expected isEqualToString:@"logged-out"]) {
        assert(store.deleted.count == 1);
        assert([((NSHTTPCookie *)store.deleted[0]).domain isEqualToString:@"community.test"]);
      } else assert(store.deleted.count == 0);
      if ([scenario isEqualToString:@"login"]) {
        assert(request.paths.count == 3);
        assert(store.saved.count == 1);
        assert([((NSHTTPCookie *)store.saved[0]).value isEqualToString:@"new-session"]);
      }
      if ([scenario isEqualToString:@"bad-csrf"]) assert(request.paths.count == 1);
      if ([scenario isEqualToString:@"redirect"]) assert(request.paths.count == 2 && store.saved.count == 0);
      [request release]; [store release];
    }
    puts("Native session checks passed (12 scenarios)");
  }
}
